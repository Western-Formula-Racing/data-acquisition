"""State and fault timeline queries for the Analysis tab.

Compresses state machine signals into transition segments and decodes the
PM100 fault bitfields into named fault intervals, so any time window returns
a payload of a few kilobytes at most regardless of window length.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import psycopg2

from backend.series_queries import (
    MAX_WINDOW_DAYS,
    STATEMENT_TIMEOUT_MS,
    _epoch_ms,
    _quoted,
    _table,
    normalize_utc,
)

GAP_SECONDS = 5
GAP_MS = GAP_SECONDS * 1000
LOOKBACK_HOURS = 1

STATE_LANES = (
    {"id": "car", "signal": "State", "label": "Car", "message": "VCU_State_Info"},
    {
        "id": "inverter",
        "signal": "INV_VSM_State",
        "label": "Inverter",
        "message": "M170_Internal_States",
    },
)

# (source, column, bit offset into the 32-entry name tables, message name)
FAULT_SOURCES = (
    ("post", "INV_Post_Fault_Lo", 0, "M171_Fault_Codes"),
    ("post", "INV_Post_Fault_Hi", 16, "M171_Fault_Codes"),
    ("run", "INV_Run_Fault_Lo", 0, "M171_Fault_Codes"),
    ("run", "INV_Run_Fault_Hi", 16, "M171_Fault_Codes"),
)

# PM100/CM200 fault bit names (Cascadia Motion CAN protocol). None marks a
# reserved bit that is never reported. The DBC only says "refer to the PM100
# manual", so these tables are the decode source of truth.
POST_FAULT_NAMES = (
    "Hardware Gate/Desaturation Fault",
    "HW Over-current Fault",
    "Accelerator Shorted",
    "Accelerator Open",
    "Current Sensor Low",
    "Current Sensor High",
    "Module Temperature Low",
    "Module Temperature High",
    "Control PCB Temperature Low",
    "Control PCB Temperature High",
    "Gate Drive PCB Temperature Low",
    "Gate Drive PCB Temperature High",
    "5V Sense Voltage Low",
    "5V Sense Voltage High",
    "12V Sense Voltage Low",
    "12V Sense Voltage High",
    "2.5V Sense Voltage Low",
    "2.5V Sense Voltage High",
    "1.5V Sense Voltage Low",
    "1.5V Sense Voltage High",
    "DC Bus Voltage High",
    "DC Bus Voltage Low",
    "Precharge Timeout",
    "Precharge Voltage Failure",
    "EEPROM Checksum Invalid",
    "EEPROM Data Out of Range",
    "EEPROM Update Required",
    "Hardware DC Bus Over-Voltage",
    None,
    None,
    "Brake Shorted",
    "Brake Open",
)

RUN_FAULT_NAMES = (
    "Motor Over-speed Fault",
    "Over-current Fault",
    "Over-voltage Fault",
    "Inverter Over-temperature Fault",
    "Accelerator Input Shorted Fault",
    "Accelerator Input Open Fault",
    "Direction Command Fault",
    "Inverter Response Time-out Fault",
    "Hardware Gate/Desaturation Fault",
    "Hardware Over-current Fault",
    "Under-voltage Fault",
    "CAN Command Message Lost Fault",
    "Motor Over-temperature Fault",
    None,
    None,
    None,
    "Brake Input Shorted Fault",
    "Brake Input Open Fault",
    "Module A Over-temperature Fault",
    "Module B Over-temperature Fault",
    "Module C Over-temperature Fault",
    "PCB Over-temperature Fault",
    "Gate Drive Board 1 Over-temperature Fault",
    "Gate Drive Board 2 Over-temperature Fault",
    "Gate Drive Board 3 Over-temperature Fault",
    "Current Sensor Fault",
    None,
    None,
    None,
    None,
    "Resolver Not Connected",
    None,
)

FAULT_NAME_TABLES = {"post": POST_FAULT_NAMES, "run": RUN_FAULT_NAMES}


def validate_states_request(start: datetime, end: datetime) -> None:
    start_utc = normalize_utc(start)
    end_utc = normalize_utc(end)
    if start_utc >= end_utc:
        raise ValueError("start must be before end")
    if end_utc - start_utc > timedelta(days=MAX_WINDOW_DAYS):
        raise ValueError("window cannot exceed seven days")


def build_columns_sql() -> str:
    return (
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = %(table)s AND column_name = ANY(%(columns)s)"
    )


def build_transitions_sql(table: str, signal: str) -> str:
    column = _quoted(signal)
    return (
        "SELECT time, value, prev_time FROM ("
        f"SELECT time, {column} AS value, "
        f"LAG({column}) OVER (ORDER BY time) AS prev_value, "
        "LAG(time) OVER (ORDER BY time) AS prev_time "
        f"FROM {_table(table)} "
        "WHERE time >= %(start)s AND time <= %(end)s "
        f"AND {column} IS NOT NULL "
        "AND message_name = %(message)s"
        ") AS samples "
        "WHERE prev_value IS DISTINCT FROM value "
        f"OR time - prev_time > interval '{GAP_SECONDS} seconds' "
        "ORDER BY time"
    )


def build_lookback_sql(table: str, signal: str) -> str:
    column = _quoted(signal)
    return (
        f"SELECT {column} FROM {_table(table)} "
        "WHERE time < %(start)s AND time >= %(lookback)s "
        f"AND {column} IS NOT NULL AND message_name = %(message)s "
        "ORDER BY time DESC LIMIT 1"
    )


def build_last_sample_sql(table: str, signal: str) -> str:
    column = _quoted(signal)
    return (
        f"SELECT time FROM {_table(table)} "
        "WHERE time >= %(start)s AND time <= %(end)s "
        f"AND {column} IS NOT NULL AND message_name = %(message)s "
        "ORDER BY time DESC LIMIT 1"
    )


def assemble_segments(
    transition_rows: list[tuple[int, int, int | None]],
    seed_value: int | None,
    window_start_ms: int,
    last_sample_ms: int | None,
) -> list[dict]:
    """Turn transition rows into value segments.

    transition_rows are (t_ms, value, prev_t_ms) ordered by time. The first
    in-window row always appears because LAG() yields NULL there. Each row
    closes the open segment (at prev_t_ms for gaps, at t_ms for changes) and
    opens a new one. The seed is the state just before the window; it is
    ignored when the first sample arrives more than GAP_MS after window start,
    because nothing proves the seeded state persisted across that silence.
    """
    if last_sample_ms is None or not transition_rows:
        return []
    segments: list[dict] = []
    first_t = transition_rows[0][0]
    current_value: int | None = None
    current_start = window_start_ms
    if seed_value is not None and first_t - window_start_ms <= GAP_MS:
        current_value = seed_value
    for t_ms, value, prev_t_ms in transition_rows:
        is_gap = prev_t_ms is not None and t_ms - prev_t_ms > GAP_MS
        if current_value is not None:
            if value == current_value and not is_gap:
                # Only reachable when the seed matches the first sample; the
                # open segment simply continues.
                continue
            end = prev_t_ms if is_gap else t_ms
            if end is not None and end > current_start:
                segments.append(
                    {"start_ms": current_start, "end_ms": end, "value": current_value}
                )
        current_value = value
        current_start = t_ms
    if current_value is not None and last_sample_ms > current_start:
        segments.append(
            {"start_ms": current_start, "end_ms": last_sample_ms, "value": current_value}
        )
    return segments


def label_segments(segments: list[dict], choices: dict[int, str] | None) -> list[dict]:
    for segment in segments:
        label = choices.get(segment["value"]) if choices else None
        segment["label"] = label if label is not None else f"state {segment['value']}"
    return segments


def decode_fault_segments(
    bitfield_segments: list[dict],
    names: tuple,
    bit_offset: int,
) -> dict[str, list[tuple[int, int]]]:
    faults: dict[str, list[tuple[int, int]]] = {}
    for segment in bitfield_segments:
        value = int(segment["value"])
        for bit in range(16):
            if not value >> bit & 1:
                continue
            name = names[bit_offset + bit]
            if name is None:
                continue
            faults.setdefault(name, []).append((segment["start_ms"], segment["end_ms"]))
    return faults


def merge_intervals(intervals: list[tuple[int, int]]) -> list[dict]:
    merged: list[list[int]] = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [{"start_ms": s, "end_ms": e} for s, e in merged]


def execute_states_query(
    *,
    postgres_dsn: str,
    table: str,
    start: datetime,
    end: datetime,
    choices_by_signal: dict[str, dict[int, str] | None] | None = None,
) -> dict:
    start_utc = normalize_utc(start)
    end_utc = normalize_utc(end)
    validate_states_request(start_utc, end_utc)
    choices_by_signal = choices_by_signal or {}
    window_start_ms = _epoch_ms(start_utc)
    params = {"start": start_utc, "end": end_utc}
    lookback_params = {
        "start": start_utc,
        "lookback": start_utc - timedelta(hours=LOOKBACK_HOURS),
    }
    wanted = [lane["signal"] for lane in STATE_LANES] + [c for _, c, _, _ in FAULT_SOURCES]
    lanes: list[dict] = []
    fault_lists: dict[tuple[str, str], list[tuple[int, int]]] = {}
    fault_order: list[tuple[str, str]] = []

    with psycopg2.connect(postgres_dsn) as conn:
        with conn.cursor() as cur:
            cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            cur.execute(f"SET LOCAL statement_timeout = {STATEMENT_TIMEOUT_MS}")
            cur.execute(build_columns_sql(), {"table": _table(table), "columns": wanted})
            present = {row[0] for row in cur.fetchall()}

            def segments_for(signal: str, message: str) -> list[dict]:
                lookback_query_params = {**lookback_params, "message": message}
                query_params = {**params, "message": message}
                cur.execute(build_lookback_sql(table, signal), lookback_query_params)
                row = cur.fetchone()
                seed = int(row[0]) if row is not None else None
                cur.execute(build_last_sample_sql(table, signal), query_params)
                row = cur.fetchone()
                last_ms = _epoch_ms(row[0]) if row is not None else None
                cur.execute(build_transitions_sql(table, signal), query_params)
                rows = [
                    (
                        _epoch_ms(r[0]),
                        int(r[1]),
                        _epoch_ms(r[2]) if r[2] is not None else None,
                    )
                    for r in cur.fetchall()
                ]
                return assemble_segments(rows, seed, window_start_ms, last_ms)

            for lane in STATE_LANES:
                if lane["signal"] not in present:
                    continue
                segments = label_segments(
                    segments_for(lane["signal"], lane["message"]),
                    choices_by_signal.get(lane["signal"]),
                )
                lanes.append(
                    {
                        "id": lane["id"],
                        "signal": lane["signal"],
                        "label": lane["label"],
                        "segments": segments,
                    }
                )

            for source, column, bit_offset, message in FAULT_SOURCES:
                if column not in present:
                    continue
                decoded = decode_fault_segments(
                    segments_for(column, message), FAULT_NAME_TABLES[source], bit_offset
                )
                for name, intervals in decoded.items():
                    key = (source, name)
                    if key not in fault_lists:
                        fault_lists[key] = []
                        fault_order.append(key)
                    fault_lists[key].extend(intervals)

    faults = [
        {
            "name": name,
            "source": source,
            "segments": merge_intervals(fault_lists[(source, name)]),
        }
        for source, name in fault_order
    ]
    faults.sort(key=lambda f: f["segments"][0]["start_ms"])
    return {"lanes": lanes, "faults": faults}
