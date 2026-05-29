#!/usr/bin/env python3
"""
Guided anomaly scan over a day of WFR telemetry (Option B: fixed checklist).

Design
------
Deterministic SQL pulls a 1-second-bucketed signal matrix from TimescaleDB,
collapsing the sparse-wide hypertable (one message per row, signal columns added
lazily) into a dense wide frame via time_bucket() + conditional aggregates. A
fixed checklist then computes statistics in pandas. The LLM (MiniMax via
langchain-anthropic) is spent only on the valuable part — reasoning over the
structured findings and emitting a triaged report. The SQL is cheap, repeatable,
and never hallucinates; the model never sees raw rows, only summarised numbers.

Usage
-----
    python anomaly_scan.py --date 2026-05-28 --table wfr26
    python anomaly_scan.py --date 2026-05-28 --no-llm          # stats only
    python anomaly_scan.py --date 2026-05-28 --slack-channel C0XXXX
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import psycopg2

POSTGRES_DSN = os.environ.get(
    "POSTGRES_DSN", "postgresql://wfr:wfr_password@timescaledb:5432/wfr"
)
TZ = ZoneInfo(os.environ.get("SCAN_TZ", "America/Toronto"))

# Roughly: motor is doing real work above this electrical speed (rpm).
SPINNING_RPM = 500.0

# role -> column name in the hypertable. Only columns that actually exist in the
# target table are selected (checked against information_schema at runtime).
SIGNALS: dict[str, str] = {
    "motor_speed": "INV_Motor_Speed",
    "motor_temp": "INV_Motor_Temp",
    "hotspot_temp": "INV_Hot_Spot_Temp",
    "coolant_temp": "INV_Coolant_Temp",
    "module_a_temp": "INV_Module_A_Temp",
    "module_b_temp": "INV_Module_B_Temp",
    "module_c_temp": "INV_Module_C_Temp",
    "dc_bus_v": "INV_DC_Bus_Voltage",
    "dc_bus_i": "INV_DC_Bus_Current",
    "torque_cmd": "INV_Commanded_Torque",
    "torque_fb": "INV_Torque_Feedback",
    "run_fault_lo": "INV_Run_Fault_Lo",
    "run_fault_hi": "INV_Run_Fault_Hi",
    "post_fault_lo": "INV_Post_Fault_Lo",
    "post_fault_hi": "INV_Post_Fault_Hi",
    "inv_enabled": "INV_Inverter_Enable_State",
    "cell_min_v": "MinCellVoltage",
    "cell_max_v": "MaxCellVoltage",
    "pack_temp_max": "MaxTemp",
    "pack_temp_min": "MinTemp",
    "pack_current": "PackCurrent",
    "soc": "SOC",
    "hv_active": "HV_Active",
    "left_rpm": "Left_RPM",
    "right_rpm": "Right_RPM",
    "bms_error": "Error_code",
}

# Signals where the bucket value should be a sum-of-presence (faults/flags), so a
# transient nonzero inside the second is not lost. Everything else uses max().
FLAG_ROLES = {
    "run_fault_lo", "run_fault_hi", "post_fault_lo", "post_fault_hi", "bms_error",
}


def _existing_columns(cur, table: str) -> set[str]:
    cur.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_name = %s",
        (table,),
    )
    return {r[0] for r in cur.fetchall()}


def fetch_matrix(table: str, start: datetime, end: datetime) -> pd.DataFrame:
    """One query: collapse the sparse-wide hypertable into a dense 1s frame.

    For each 1-second bucket, each signal's value is the max of the (at most a
    few) raw samples in that second. Because every raw row only populates its own
    message's columns, max() over the bucket cleanly pivots message rows into a
    wide row without an explicit join.
    """
    conn = psycopg2.connect(POSTGRES_DSN)
    try:
        with conn.cursor() as cur:
            present = _existing_columns(cur, table)
            roles = {r: c for r, c in SIGNALS.items() if c in present}
            if not roles:
                raise SystemExit(f"None of the expected signals exist in {table!r}")

            selects = ",\n  ".join(
                f'max("{col}") AS {role}' for role, col in roles.items()
            )
            sql = (
                f"SELECT time_bucket('1 second', time) AS t,\n  {selects}\n"
                f"FROM {table}\n"
                "WHERE time >= %s AND time < %s\n"
                "GROUP BY t ORDER BY t"
            )
            cur.execute(sql, (start, end))
            cols = ["t"] + list(roles.keys())
            df = pd.DataFrame(cur.fetchall(), columns=cols)
    finally:
        conn.close()

    if df.empty:
        return df
    df["t"] = pd.to_datetime(df["t"])
    df = df.set_index("t")
    return df.astype("float64", errors="ignore")


def fetch_message_rates(table: str, start: datetime, end: datetime) -> pd.DataFrame:
    conn = psycopg2.connect(POSTGRES_DSN)
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT message_name, count(*) AS n, "
                f"min(time) AS first_t, max(time) AS last_t "
                f"FROM {table} WHERE time >= %s AND time < %s "
                f"GROUP BY message_name ORDER BY n DESC",
                (start, end),
            )
            rows = cur.fetchall()
    finally:
        conn.close()
    return pd.DataFrame(rows, columns=["message_name", "n", "first_t", "last_t"])


# ── Checks ──────────────────────────────────────────────────────────────────
# Each returns a dict: {check, severity_hint, stats, note}. severity_hint is a
# cheap heuristic; the LLM makes the final call with full context.

def _stats(series: pd.Series) -> dict:
    s = series.dropna()
    if s.empty:
        return {"present": False}
    return {
        "present": True,
        "min": round(float(s.min()), 3),
        "p50": round(float(s.median()), 3),
        "p95": round(float(s.quantile(0.95)), 3),
        "max": round(float(s.max()), 3),
        "samples": int(s.size),
    }


def check_inverter_thermal(df, spinning) -> dict:
    out = {}
    for role, limit in [
        ("motor_temp", 120.0),
        ("hotspot_temp", 80.0),
        ("coolant_temp", 60.0),
        ("module_a_temp", 80.0),
        ("module_b_temp", 80.0),
        ("module_c_temp", 80.0),
    ]:
        if role in df:
            st = _stats(df[role])
            st["limit"] = limit
            if st.get("present"):
                st["seconds_over_limit"] = int((df[role] > limit).sum())
            out[role] = st
    worst = max(
        (v.get("seconds_over_limit", 0) for v in out.values() if isinstance(v, dict)),
        default=0,
    )
    return {
        "check": "inverter_thermal",
        "description": "Motor / inverter module / coolant temperatures vs limits",
        "severity_hint": "high" if worst > 30 else ("medium" if worst > 0 else "low"),
        "stats": out,
    }


def check_inverter_faults(df, spinning) -> dict:
    fault_roles = [r for r in ("run_fault_lo", "run_fault_hi", "post_fault_lo", "post_fault_hi") if r in df]
    enabled = df["inv_enabled"] > 0.5 if "inv_enabled" in df else pd.Series(False, index=df.index)
    out = {}
    for role in fault_roles:
        f = df[role].fillna(0) != 0
        out[role] = {
            "seconds_faulted_total": int(f.sum()),
            "seconds_faulted_while_enabled": int((f & enabled).sum()),
            "seconds_faulted_while_spinning": int((f & spinning).sum()),
            "distinct_codes": sorted(
                int(v) for v in df.loc[f, role].dropna().unique() if v != 0
            )[:20],
        }
    real = max((v["seconds_faulted_while_spinning"] for v in out.values()), default=0)
    return {
        "check": "inverter_faults",
        "description": (
            "Inverter run/post fault flags. Faults while idle (not enabled / not "
            "spinning) are usually benign bring-up noise; faults while spinning matter."
        ),
        "severity_hint": "high" if real > 5 else ("medium" if real > 0 else "low"),
        "stats": out,
    }


def check_dc_bus(df, spinning) -> dict:
    out = {"voltage_all": _stats(df.get("dc_bus_v", pd.Series(dtype=float)))}
    if "dc_bus_v" in df:
        out["voltage_while_spinning"] = _stats(df.loc[spinning, "dc_bus_v"])
    if "dc_bus_i" in df:
        out["current_abs"] = _stats(df["dc_bus_i"].abs())
    # Sag: lowest bus voltage during the highest-current seconds.
    sag = None
    if {"dc_bus_v", "dc_bus_i"} <= set(df.columns):
        hi_i = df["dc_bus_i"].abs() > df["dc_bus_i"].abs().quantile(0.95)
        v_under_load = df.loc[hi_i, "dc_bus_v"].dropna()
        if not v_under_load.empty:
            sag = round(float(v_under_load.min()), 1)
    out["min_voltage_under_peak_current"] = sag
    return {
        "check": "dc_bus",
        "description": "HV DC bus voltage/current; voltage sag under peak current",
        "severity_hint": "medium" if (sag is not None and sag < 250) else "low",
        "stats": out,
    }


def check_bms_cell_health(df, spinning) -> dict:
    # Cell voltages of 0 mean the module/sensor is offline — exclude from health.
    out = {}
    cmin = df.get("cell_min_v")
    cmax = df.get("cell_max_v")
    valid = None
    if cmin is not None:
        live = cmin[cmin > 1.0]
        out["min_cell_v"] = _stats(live)
        out["seconds_undervoltage_lt_3v"] = int((live < 3.0).sum())
        valid = cmin > 1.0
    if cmax is not None:
        out["max_cell_v"] = _stats(cmax[cmax > 1.0])
        out["seconds_overvoltage_gt_4_2v"] = int((cmax > 4.2).sum())
    if cmin is not None and cmax is not None and valid is not None:
        spread = (cmax - cmin)[valid]
        out["pack_spread_v"] = _stats(spread)
        out["seconds_imbalance_gt_0_3v"] = int((spread > 0.3).sum())
    if "bms_error" in df:
        e = df["bms_error"].fillna(0) != 0
        out["bms_error_seconds"] = int(e.sum())
        out["bms_error_codes"] = sorted(
            int(v) for v in df.loc[e, "bms_error"].dropna().unique() if v != 0
        )[:20]
    imbalance = out.get("seconds_imbalance_gt_0_3v", 0)
    uv = out.get("seconds_undervoltage_lt_3v", 0)
    return {
        "check": "bms_cell_health",
        "description": "Cell voltage extremes, undervoltage/overvoltage, pack imbalance (0 V = offline, excluded)",
        "severity_hint": "high" if (uv > 0 or imbalance > 10) else "low",
        "stats": out,
    }


def check_bms_thermal(df, spinning) -> dict:
    out = {
        "pack_temp_max": _stats(df.get("pack_temp_max", pd.Series(dtype=float))),
        "pack_temp_min": _stats(df.get("pack_temp_min", pd.Series(dtype=float))),
    }
    over = 0
    if "pack_temp_max" in df:
        over = int((df["pack_temp_max"] > 55.0).sum())
        out["seconds_over_55c"] = over
    return {
        "check": "bms_thermal",
        "description": "Pack temperature extremes (limit ~55 C)",
        "severity_hint": "high" if over > 0 else "low",
        "stats": out,
    }


def check_torque_tracking(df, spinning) -> dict:
    if not {"torque_cmd", "torque_fb"} <= set(df.columns):
        return {"check": "torque_tracking", "severity_hint": "low",
                "description": "Commanded vs feedback torque", "stats": {"present": False}}
    sub = df.loc[spinning, ["torque_cmd", "torque_fb"]].dropna()
    if sub.empty:
        return {"check": "torque_tracking", "severity_hint": "low",
                "description": "Commanded vs feedback torque (no spinning data)",
                "stats": {"present": False}}
    err = (sub["torque_cmd"] - sub["torque_fb"]).abs()
    return {
        "check": "torque_tracking",
        "description": "Abs error between commanded and feedback torque while spinning (Nm)",
        "severity_hint": "medium" if float(err.quantile(0.95)) > 20 else "low",
        "stats": {
            "abs_err": _stats(err),
            "cmd": _stats(sub["torque_cmd"]),
            "fb": _stats(sub["torque_fb"]),
        },
    }


def check_signal_dropout(df, rates: pd.DataFrame) -> dict:
    """Longest run of consecutive empty 1s buckets per key signal = a dropout."""
    span_s = int((df.index.max() - df.index.min()).total_seconds()) if len(df) else 0
    full = pd.date_range(df.index.min(), df.index.max(), freq="1s") if len(df) else []
    out = {}
    for role in ("motor_speed", "dc_bus_v", "cell_min_v", "left_rpm"):
        if role not in df or len(full) == 0:
            continue
        present = df[role].reindex(full).notna().values
        # longest consecutive False run
        gap, longest = 0, 0
        for ok in present:
            gap = 0 if ok else gap + 1
            longest = max(longest, gap)
        out[role] = {"longest_gap_s": int(longest), "coverage_pct": round(100 * present.mean(), 1)}
    worst = max((v["longest_gap_s"] for v in out.values()), default=0)
    return {
        "check": "signal_dropout",
        "description": f"Longest continuous gap per key signal over a {span_s}s active span",
        "severity_hint": "high" if worst > 10 else ("medium" if worst > 3 else "low"),
        "stats": out,
    }


def run_checks(df: pd.DataFrame, rates: pd.DataFrame) -> list[dict]:
    spinning = (
        df["motor_speed"].abs() > SPINNING_RPM
        if "motor_speed" in df else pd.Series(False, index=df.index)
    )
    return [
        check_inverter_thermal(df, spinning),
        check_inverter_faults(df, spinning),
        check_dc_bus(df, spinning),
        check_bms_cell_health(df, spinning),
        check_bms_thermal(df, spinning),
        check_torque_tracking(df, spinning),
        check_signal_dropout(df, rates),
    ]


# ── LLM triage ────────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """\
You are a data engineer for Western Formula Racing reviewing one day of logged \
telemetry from the WFR26 electric race car. The car uses a Cascadia inverter \
(signals prefixed INV_), a custom segmented accumulator/BMS (5 modules x ~20 \
cells, signals MinCellVoltage / MaxCellVoltage / MaxTemp / PackCurrent / SOC / \
Error_code), and a VCU (wheel speeds Left_RPM/Right_RPM, throttle/brake).

You are given the output of a fixed anomaly checklist. Each check is already \
reduced to summary statistics over 1-second buckets. Your job is to TRIAGE, not \
to invent numbers. Rules:
- Use ONLY the numbers provided. Never fabricate signal values.
- Inverter/BMS fault flags raised while the car is idle (not enabled, not \
spinning) are almost always benign power-up/bring-up noise. Only treat faults \
seen while spinning as real. Say so explicitly when you discount idle faults.
- A signal reading exactly 0 (e.g. SOC=0, a cell at 0 V) usually means it is not \
populated/online, not a real measurement. Flag it as a data-quality issue, not a \
physical anomaly.
- Be calibrated. Most days have nothing alarming. Do not manufacture drama.

Output GitHub-flavoured markdown, concise, in this shape:
*Verdict:* one line (✅ nothing notable / ⚠️ worth a look / 🚨 investigate).
Then 0-5 bullets, each: `severity` — finding — the specific number that supports \
it — suggested next check. Sort by severity. If nothing is notable, say so and \
stop.\
"""


def llm_triage(date_str: str, checks: list[dict], rates: pd.DataFrame) -> str:
    from langchain_anthropic import ChatAnthropic
    from langchain_core.messages import HumanMessage, SystemMessage

    model = os.getenv("ANTHROPIC_MODEL", "MiniMax-M2.7")
    llm = ChatAnthropic(model=model, temperature=0.1, max_tokens=2048)

    top_msgs = rates.head(8)[["message_name", "n"]].to_dict("records")
    payload = {
        "date": date_str,
        "top_messages": top_msgs,
        "checks": checks,
    }
    user = (
        f"Telemetry anomaly checklist for {date_str}. Triage it.\n\n"
        f"```json\n{json.dumps(payload, default=str, indent=1)}\n```"
    )
    resp = llm.invoke([SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=user)])
    content = resp.content
    if isinstance(content, list):
        content = "\n".join(
            b.get("text", "") if isinstance(b, dict) else str(b) for b in content
        )
    return str(content).strip()


def _headline(check: dict) -> str:
    """One deterministic, human-readable line summarising a check's key numbers."""
    name = check.get("check")
    s = check.get("stats", {})
    try:
        if name == "inverter_thermal":
            mt = s.get("motor_temp", {})
            bits = []
            if mt.get("present"):
                flat = " [FLAT — likely stuck sensor]" if mt["min"] == mt["max"] else ""
                over = f", over-limit {mt['seconds_over_limit']}s" if mt.get("seconds_over_limit") else ""
                bits.append(f"motor {mt['max']}°C{flat}{over}")
            for role in ("hotspot_temp", "coolant_temp"):
                r = s.get(role, {})
                if r.get("present"):
                    bits.append(f"{role.split('_')[0]} {r['max']}°C")
            return "; ".join(bits) or "no temperature data"
        if name == "inverter_faults":
            spin = sum(v.get("seconds_faulted_while_spinning", 0) for v in s.values())
            total = sum(v.get("seconds_faulted_total", 0) for v in s.values())
            codes = sorted({c for v in s.values() for c in v.get("distinct_codes", [])})
            return (f"faults while spinning {spin}s (codes {codes or '—'}); "
                    f"{total}s total incl. idle (idle discounted)")
        if name == "dc_bus":
            vs = s.get("voltage_while_spinning", {})
            ia = s.get("current_abs", {})
            sag = s.get("min_voltage_under_peak_current")
            v = f"bus {vs.get('min','?')}–{vs.get('max','?')}V while spinning" if vs.get("present") else "bus n/a"
            return f"{v}, |I|max {ia.get('max','?')}A, min V under peak I {sag}"
        if name == "bms_cell_health":
            cmin = s.get("min_cell_v", {})
            cmax = s.get("max_cell_v", {})
            return (f"cells {cmin.get('min','?')}–{cmax.get('max','?')}V live (0V excluded), "
                    f"undervolt<3V {s.get('seconds_undervoltage_lt_3v',0)}s, "
                    f"imbalance>0.3V {s.get('seconds_imbalance_gt_0_3v',0)}s, "
                    f"BMS errors {s.get('bms_error_seconds',0)}s")
        if name == "bms_thermal":
            pt = s.get("pack_temp_max", {})
            return f"pack temp max {pt.get('max','?')}°C, over-55°C {s.get('seconds_over_55c',0)}s"
        if name == "torque_tracking":
            err = s.get("abs_err")
            return f"|cmd−fb| p95 {err['p95']}Nm, max {err['max']}Nm" if err else "no spinning data"
        if name == "signal_dropout":
            worst = max(s.items(), key=lambda kv: kv[1].get("longest_gap_s", 0), default=(None, {}))
            if worst[0]:
                return f"longest gap {worst[1]['longest_gap_s']}s on {worst[0]} ({worst[1]['coverage_pct']}% coverage)"
            return "no coverage data"
    except Exception:
        pass
    return check.get("description", "")


_SEV_RANK = {"low": 1, "medium": 2, "high": 3}
_SEV_EMOJI = {"low": "🟢", "medium": "🟡", "high": "🔴"}


def render_markdown(date_str: str, checks: list[dict]) -> str:
    """Deterministic report: verdict + one bullet per check, no LLM involved."""
    worst = max((_SEV_RANK.get(c.get("severity_hint", "low"), 1) for c in checks), default=1)
    verdict = {3: "🚨 investigate", 2: "⚠️ worth a look", 1: "✅ nothing notable"}[worst]
    lines = [f"*Verdict:* {verdict}", ""]
    for c in sorted(checks, key=lambda c: -_SEV_RANK.get(c.get("severity_hint", "low"), 1)):
        sev = c.get("severity_hint", "low")
        lines.append(f"{_SEV_EMOJI[sev]} *{sev}* — {c['check']} — {_headline(c)}")
    return "\n".join(lines)


def post_to_slack(channel: str, text: str) -> None:
    import requests

    token = os.environ.get("SLACK_BOT_TOKEN")
    if not token:
        print("SLACK_BOT_TOKEN not set — skipping Slack post", file=sys.stderr)
        return
    r = requests.post(
        "https://slack.com/api/chat.postMessage",
        headers={"Authorization": f"Bearer {token}"},
        json={"channel": channel, "text": text, "unfurl_links": False},
        timeout=20,
    )
    ok = r.json().get("ok")
    if not ok:
        print(f"Slack post failed: {r.text}", file=sys.stderr)


def main() -> None:
    ap = argparse.ArgumentParser(description="Guided telemetry anomaly scan")
    ap.add_argument("--date", required=True, help="local day to scan, YYYY-MM-DD")
    ap.add_argument("--table", default="wfr26")
    ap.add_argument("--no-llm", action="store_true", help="print stats JSON only")
    ap.add_argument("--md", action="store_true", help="print deterministic markdown report (no LLM)")
    ap.add_argument("--slack-channel", default=None)
    args = ap.parse_args()

    day = datetime.strptime(args.date, "%Y-%m-%d").replace(tzinfo=TZ)
    start, end = day, day + timedelta(days=1)

    df = fetch_matrix(args.table, start, end)
    if df.empty:
        print(f"No data in {args.table} for {args.date}.")
        return
    rates = fetch_message_rates(args.table, start, end)
    checks = run_checks(df, rates)

    if args.no_llm:
        print(json.dumps({"date": args.date, "checks": checks}, default=str, indent=2))
        return

    if args.md:
        print(render_markdown(args.date, checks))
        return

    report = llm_triage(args.date, checks, rates)
    header = f"*🔎 WFR anomaly scan — {args.date} ({args.table})*"
    full = f"{header}\n{report}"
    print(full)
    if args.slack_channel:
        post_to_slack(args.slack_channel, full)


if __name__ == "__main__":
    main()
