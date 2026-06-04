"""
State-of-Charge (SOC) + charge time-to-full estimation.

DATA-DERIVED MODEL. Replaces the earlier provisional first-principles version.
Derived from the wfr26 TimescaleDB hypertable (2026-04-11 .. 2026-06-01, ~78M rows).

Key findings from the data audit (these drive every design choice below):
  * `PackCurrent` is DEAD: constant -3276.0 sentinel on every PackStatus row. UNUSABLE.
    -> Coulomb counting is impossible. `current_a` from the bot is ignored for SOC.
  * `SOC` (BMS) is DEAD: constant 0.0 on every PackStatus row. UNUSABLE.
    -> We still PREFER a BMS SOC if a future firmware fix makes it real (0 < soc <= 100).
  * `PackVoltage` column does not exist. (Inverter DC bus ~191 V lives on M167_Voltage_Info,
    but that's inverter-side and not used here.)
  * Per-cell voltages (TORCH_M{1..5}_V{1..5} -> M{m}_Cell{1..20}_Voltage) are RELIABLE
    and are the ONLY usable SOC basis. Observed envelope for a representative cell:
        abs max 4.191 V (brief regen/charge-termination peak),
        99th pct 4.097 V  (treated as full / charged rest),
        1st  pct 3.264 V, abs min 2.839 V (deep discharge under load).
  * There are NO on-log CHARGING sessions. All 41 logged sessions start near full
    (~4.06-4.12 V) and DISCHARGE; recharge happens off-log between sessions. So the
    CC->CV charge taper below is calibrated to generic Li-ion CC-CV behavior anchored
    to the observed 4.097 V rest / 4.19 V termination spread, NOT to measured WFR
    charge current. Re-fit `_CV_TAPER` once a real charge session is logged.

Public contract `estimate_soc_and_eta(history) -> dict` is unchanged; the charge
dashboard (charge_dashboard.py) depends on it.
"""

from __future__ import annotations

# --- Pack constants (data-derived) ------------------------------------------
SERIES_CELLS = 100  # 5 modules x 20 cells (confirmed: TORCH_M{1..5}_V{1..5}, 4 cells/msg)

# OCV (rest / lightly-loaded cell voltage) -> SOC %.
# Upper band anchored to data (4.097 V = ~full from 99th pct; ~3.0 V = empty under
# load). Mid/lower knees use standard Li-ion OCV plateau shape since the dataset
# cleanly spans only the working/upper band.
_OCV_SOC = [
    (3.00, 0.0), (3.30, 5.0), (3.50, 12.0), (3.65, 22.0), (3.75, 35.0),
    (3.85, 50.0), (3.92, 65.0), (3.98, 78.0), (4.04, 88.0),
    (4.097, 97.0),                       # observed 99th-pct charged-rest level
    (4.15, 99.5), (4.20, 100.0),
]

CELL_FULL_V = 4.09        # limiting cell at/above this resting level => full
CV_KNEE_V = 4.00          # high cell above this => charger in CV, current taping
FULL_SOC_PCT = 99.5
CHARGE_CURRENT_EPS = 0.5  # |A| below this is idle (kept for the BMS-fixed future case)


def _interp(x: float, table) -> float:
    if x <= table[0][0]:
        return table[0][1]
    if x >= table[-1][0]:
        return table[-1][1]
    for (x0, y0), (x1, y1) in zip(table, table[1:]):
        if x0 <= x <= x1:
            return y0 if x1 == x0 else y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return table[-1][1]


def _soc_from_voltage(cell_v: float) -> float:
    """OCV->SOC lookup (data-derived breakpoints)."""
    return max(0.0, min(100.0, _interp(cell_v, _OCV_SOC)))


def _pick_cell(sample: dict):
    """Limiting (min) cell voltage for SOC; fall back to avg. Returns None if junk."""
    v = sample.get("min_cell_v")
    if not (v and 2.5 < v < 4.3):
        v = sample.get("avg_cell_v")
    return v if (v and 2.5 < v < 4.3) else None


def _sample_soc(sample: dict) -> float | None:
    """SOC for one sample: real BMS SOC if present, else OCV from limiting cell."""
    bms = sample.get("soc")
    if bms is not None and 0.0 < bms <= 100.0:
        return float(bms)
    v = _pick_cell(sample)
    return _soc_from_voltage(v) if v is not None else None


def _CV_TAPER(soc_pct: float) -> float:
    """Time-stretch vs the linear CC rate, by SOC.
    1.0 in deep CC; grows toward the top as CV current decays. Calibrated so the
    final ~3% of SOC costs ~6x per-percent time and the 80-97% band ramps 1.0->3.5x
    (classic CV tail). Generic Li-ion shape (no on-log charge session to fit)."""
    if soc_pct < 80.0:
        return 1.0
    if soc_pct >= 99.0:
        return 6.0
    if soc_pct < 97.0:
        return 1.0 + (soc_pct - 80.0) / 17.0 * 2.5   # 1.0 .. 3.5
    return 3.5 + (soc_pct - 97.0) / 2.0 * 2.5         # 3.5 .. 6.0


def _trailing_rate_pct_per_min(history: list[dict]) -> float | None:
    """dSOC/dt (%/min) over the trailing window using one consistent SOC basis."""
    pts = [(h["t"], _sample_soc(h)) for h in history]
    pts = [(t, s) for t, s in pts if s is not None]
    if len(pts) < 2:
        return None
    (t0, s0), (t1, s1) = pts[0], pts[-1]
    dt_min = (t1 - t0) / 60.0
    if dt_min <= 0.05:
        return None
    return (s1 - s0) / dt_min


def _eta_minutes(soc_pct: float, rate_pct_per_min: float | None) -> float | None:
    """Minutes to FULL_SOC_PCT, integrating the CV taper so the near-100% slowdown
    is accounted for (a naive linear ETA badly UNDER-estimates time near full)."""
    if rate_pct_per_min is None or rate_pct_per_min <= 0 or soc_pct >= FULL_SOC_PCT:
        return None
    remaining = FULL_SOC_PCT - soc_pct
    steps, eta = 20, 0.0
    for i in range(steps):
        s_mid = soc_pct + remaining * (i + 0.5) / steps
        eta += (remaining / steps) / rate_pct_per_min * _CV_TAPER(s_mid)
    return round(eta, 1)


def estimate_soc_and_eta(history: list[dict]) -> dict:
    """
    Estimate SOC and time-to-full from a trailing window of charge samples.

    history: chronological list of samples, each:
        {"t": epoch_seconds, "current_a": float, "pack_v": float|None,
         "soc": float|None,                       # BMS-reported (DEAD in logged data)
         "min_cell_v": float, "avg_cell_v": float, "max_cell_v": float|None}

    Returns: {"soc_pct": float, "eta_min_to_full": float|None,
              "phase": "CC"|"CV"|"full"|"idle", "method": str}
    """
    if not history:
        return {"soc_pct": 0.0, "eta_min_to_full": None, "phase": "idle", "method": "empty"}

    hist = sorted(history, key=lambda s: s.get("t", 0))
    latest = hist[-1]

    soc = _sample_soc(latest)
    if soc is None:
        return {"soc_pct": 0.0, "eta_min_to_full": None,
                "phase": "idle", "method": "no-valid-cell-voltage"}
    method = "bms" if (latest.get("soc") and 0.0 < latest["soc"] <= 100.0) else "ocv-mincell"

    # Phase: current is dead, so infer charge/discharge from the SOC (voltage) trend.
    rate = _trailing_rate_pct_per_min(hist)
    vmin = latest.get("min_cell_v") or latest.get("avg_cell_v") or 0.0
    vmax = latest.get("max_cell_v") or latest.get("avg_cell_v") or 0.0

    if vmin >= CELL_FULL_V or soc >= FULL_SOC_PCT:
        phase = "full"
    elif rate is not None and rate > 0.02:          # SOC rising => charging
        phase = "CV" if vmax >= CV_KNEE_V else "CC"
    else:                                            # falling or flat => not charging
        phase = "idle"

    eta = _eta_minutes(soc, rate) if phase in ("CC", "CV") else (0.0 if phase == "full" else None)

    return {"soc_pct": round(soc, 1), "eta_min_to_full": eta, "phase": phase, "method": method}


if __name__ == "__main__":
    import time as _t
    now = _t.time()
    print(estimate_soc_and_eta([
        {"t": now - 600, "current_a": -3276, "pack_v": 191, "soc": 0,
         "min_cell_v": 3.82, "avg_cell_v": 3.85, "max_cell_v": 3.88},
        {"t": now, "current_a": -3276, "pack_v": 191, "soc": 0,
         "min_cell_v": 3.90, "avg_cell_v": 3.93, "max_cell_v": 3.97},
    ]))  # mid CC, rising
    print(estimate_soc_and_eta([
        {"t": now - 600, "min_cell_v": 4.02, "avg_cell_v": 4.05, "max_cell_v": 4.08,
         "current_a": -3276, "pack_v": 191, "soc": 0},
        {"t": now, "min_cell_v": 4.05, "avg_cell_v": 4.08, "max_cell_v": 4.12,
         "current_a": -3276, "pack_v": 191, "soc": 0},
    ]))  # near full, CV
    print(estimate_soc_and_eta([
        {"t": now - 600, "min_cell_v": 4.00, "avg_cell_v": 4.03, "max_cell_v": 4.06,
         "current_a": -3276, "pack_v": 191, "soc": 0},
        {"t": now, "min_cell_v": 3.90, "avg_cell_v": 3.93, "max_cell_v": 3.97,
         "current_a": -3276, "pack_v": 191, "soc": 0},
    ]))  # discharging -> idle, no ETA
