"""
Charging dashboard — a single self-updating Slack message (TUI style), driven
by snapshots POSTed from Pecan's accumulator page when charging via the Kvaser
bridge on the internal (pecan-dev) build.

Mechanic mirrors the file-uploader's SlackProgressNotifier: post one message,
then chat.update it in place every tick. Pecan sends data; the bot draws the art.

Wiring:
    from charge_dashboard import ChargeDashboard, start_http_server
    dash = ChargeDashboard(web_client, default_channel)
    start_http_server(dash, port=CHARGE_PORT, token=CHARGE_RELAY_TOKEN)

HTTP (behind Cloudflare Zero Trust):
    POST /charging/state   X-Charge-Token: <shared secret>   body: snapshot JSON
    GET  /healthz
"""

from __future__ import annotations

import json
import threading
import time
from collections import deque
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

from soc_model import estimate_soc_and_eta

TZ_ET = ZoneInfo("America/Toronto")

# Mark a session stale if Pecan stops POSTing for this long (heartbeat).
STALE_AFTER_S = 15
# Keep this many trailing samples per session for the dSOC/dt rate estimate.
HISTORY_LEN = 120

_BLOCKS = "▁▂▃▄▅▆▇█"  # 8 levels, low→high
_STATE_EMOJI = {
    "charging": "🔋", "discharging": "⚡", "standby": "🔌",
    "full": "✅", "stale": "⚠️", "idle": "🔌",
}
_STATE_LABEL = {
    "charging": "Charging", "discharging": "Discharging", "standby": "Standby",
    "full": "Full & balanced", "stale": "Stale — no data", "idle": "Idle",
}
_CHIP = {"ok": "✓", "warn": "⚠", "crit": "✕"}
# soc_model phase → dashboard state. Current is dead in real telemetry, so the
# voltage-trend phase from the model is the only authority on charge state.
_PHASE_STATE = {"CC": "charging", "CV": "charging", "full": "full", "idle": "standby"}


# --- formatting helpers -----------------------------------------------------

def _bar(pct: float, width: int = 20) -> str:
    pct = max(0.0, min(100.0, pct))
    filled = int(round(width * pct / 100.0))
    return "▓" * filled + "░" * (width - filled)


def _spark(cells: list, lo: float, hi: float) -> str:
    if not cells:
        return " " * 20
    span = (hi - lo) or 1e-6
    out = []
    for v in cells:
        if v is None:
            out.append(" ")
            continue
        frac = max(0.0, min(1.0, (v - lo) / span))
        out.append(_BLOCKS[int(round(frac * (len(_BLOCKS) - 1)))])
    return "".join(out)


def _eta_str(eta_min: float | None) -> str:
    if eta_min is None:
        return "—"
    if eta_min < 1:
        return "~<1m to full"
    if eta_min < 60:
        return f"~{int(round(eta_min))}m to full"
    return f"~{eta_min / 60:.1f}h to full"


def _hms(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"


def _num(v, fmt: str, dash: str = "--"):
    return format(v, fmt) if v is not None else dash


def render_dashboard(snap: dict, derived: dict, eta_min: float | None, state: str) -> str:
    """Build the full Slack message text (mrkdwn header + one monospace block)."""
    soc = derived.get("soc_pct")
    emoji = _STATE_EMOJI.get(state, "🔋")
    label = _STATE_LABEL.get(state, state.title())
    elapsed = _hms(snap.get("elapsed_s", 0))

    header = f"{emoji} *{label}* · WFR Accumulator · ⏱ {elapsed}"

    minc = snap.get("min_cell") or {}
    maxc = snap.get("max_cell") or {}
    maxt = snap.get("max_temp") or {}
    mint = snap.get("min_temp") or {}
    alerts = snap.get("alerts") or {}
    delta_flag = " ⚠" if alerts.get("voltdelta") in ("warn", "crit") else ""

    # pack-wide cell min/max → sparkline normalization (dragging cell = ▁ everywhere)
    all_cells = [c for m in snap.get("modules", []) for c in (m.get("cells") or []) if c is not None]
    lo = min(all_cells) if all_cells else 3.0
    hi = max(all_cells) if all_cells else 4.2

    # NB: PackCurrent / BMS-SOC / PackVoltage are dead in the real telemetry
    # (see soc_model.py). SOC and phase are derived from cell-voltage OCV, so the
    # SoC line shows the model phase (CC/CV/full/idle), not amperage.
    phase = (derived.get("phase") or "").upper()

    L = []
    L.append(f"SoC  {_bar(soc or 0)}  {_num(soc, '.0f')}%     "
             f"{phase}  ·  {_eta_str(eta_min)}")
    L.append(f"Pack {_num(snap.get('pack_v'), '.1f')} V    AVG {_num(snap.get('avg_v'), '.2f')} V    "
             f"Δ {_num(snap.get('delta_mv'), '.0f')} mV{delta_flag}")
    L.append(f"Cell  min {_num(minc.get('v'), '.3f')}  {minc.get('label', '--'):<8} "
             f"  max {_num(maxc.get('v'), '.3f')}  {maxc.get('label', '--')}")
    L.append(f"Temp  max {_num(maxt.get('c'), '.1f')}° {maxt.get('label', '--'):<8} "
             f"  min {_num(mint.get('c'), '.1f')}°")
    L.append(f"Alert  VOLTΔ{_CHIP.get(alerts.get('voltdelta'), '·')}   "
             f"TEMP{_CHIP.get(alerts.get('temp'), '·')}   "
             f"BAL{_CHIP.get(alerts.get('bal'), '·')}   "
             f"LOW{_CHIP.get(alerts.get('low'), '·')}")
    L.append("─" * 60)
    L.append(f"{'Mod':<4}{'cells (20, low→high)':<24}{'avg':>6} {'min':>6} {'max':>6} {'Δ':>6} {'Tmax':>7}")
    for m in snap.get("modules", []):
        spark = _spark(m.get("cells") or [], lo, hi)
        tflag = " ⚠" if (m.get("tmax") is not None and m["tmax"] >= 55) else ""
        L.append(
            f"{m.get('id', '--'):<4}{spark:<24}"
            f"{_num(m.get('avg'), '.2f'):>6} {_num(m.get('min'), '.2f'):>6} "
            f"{_num(m.get('max'), '.2f'):>6} {_num(m.get('delta_mv'), '.0f') + 'mV':>6} "
            f"{_num(m.get('tmax'), '.1f') + '°':>7}{tflag}"
        )

    block = "```\n" + "\n".join(L) + "\n```"
    now_et = datetime.now(TZ_ET).strftime("%H:%M:%S")
    src = snap.get("source", "kvaser-bridge")
    env = snap.get("env", "pecan-dev")
    footer = f"updated {now_et} ET · source: {src} · {env}"
    return f"{header}\n{block}\n{footer}"


# --- session state + Slack posting ------------------------------------------

class _Session:
    __slots__ = ("ts", "channel", "start", "last_seen", "history", "stale_marked", "finalized")

    def __init__(self, channel: str):
        self.ts: str | None = None
        self.channel = channel
        self.start = time.time()
        self.last_seen = time.time()
        self.history: deque = deque(maxlen=HISTORY_LEN)
        self.stale_marked = False
        self.finalized = False


class ChargeDashboard:
    """Manages one live Slack message per charging session."""

    def __init__(self, web_client, default_channel: str):
        self._web = web_client
        self._default_channel = default_channel
        self._sessions: dict[str, _Session] = {}
        self._lock = threading.Lock()
        threading.Thread(target=self._heartbeat_loop, daemon=True).start()

    def handle(self, snap: dict) -> None:
        """Process one snapshot POSTed by Pecan."""
        sid = snap.get("session")
        if not sid:
            return
        channel = snap.get("channel") or self._default_channel

        with self._lock:
            sess = self._sessions.get(sid)
            if sess is None:
                sess = self._sessions[sid] = _Session(channel)
            sess.last_seen = time.time()
            sess.stale_marked = False
            sess.history.append({
                "t": time.time(),
                "current_a": snap.get("current_a", 0.0),
                "pack_v": snap.get("pack_v"),
                "soc": snap.get("soc"),
                "min_cell_v": (snap.get("min_cell") or {}).get("v"),
                "avg_cell_v": snap.get("avg_v"),
                "max_cell_v": (snap.get("max_cell") or {}).get("v"),
            })
            history = list(sess.history)
            ts = sess.ts

        derived = estimate_soc_and_eta(history)
        eta = derived.get("eta_min_to_full")
        # State is driven by the model's phase, NOT Pecan's reported current — the
        # real telemetry's PackCurrent/SOC are dead sentinels (see soc_model.py).
        state = _PHASE_STATE.get(derived.get("phase"), "standby")
        text = render_dashboard(snap, derived, eta, state)

        new_ts = self._post_or_update(channel, ts, text)
        with self._lock:
            sess = self._sessions.get(sid)
            if sess is not None:
                if sess.ts is None and new_ts:
                    sess.ts = new_ts
                if state == "full":
                    sess.finalized = True

    def _post_or_update(self, channel: str, ts: str | None, text: str) -> str | None:
        try:
            if ts is None:
                resp = self._web.chat_postMessage(channel=channel, text=text, mrkdwn=True)
                return resp.get("ts")
            self._web.chat_update(channel=channel, ts=ts, text=text, mrkdwn=True)
            return ts
        except Exception as e:  # noqa: BLE001 — never let Slack errors kill the request
            print(f"⚡ charge dashboard slack error: {e}")
            return ts

    def _heartbeat_loop(self) -> None:
        while True:
            time.sleep(5)
            now = time.time()
            stale: list[tuple[str, str]] = []
            with self._lock:
                for sid, s in self._sessions.items():
                    if (not s.finalized and not s.stale_marked
                            and s.ts and now - s.last_seen > STALE_AFTER_S):
                        s.stale_marked = True
                        stale.append((sid, s.channel))
            for sid, channel in stale:
                self._mark_stale(sid, channel)

    def _mark_stale(self, sid: str, channel: str) -> None:
        with self._lock:
            sess = self._sessions.get(sid)
            if sess is None or not sess.history:
                return
            history = list(sess.history)
            ts = sess.ts
            elapsed = time.time() - sess.start
        derived = estimate_soc_and_eta(history)
        last = history[-1]
        snap = {
            "elapsed_s": elapsed, "current_a": last["current_a"], "pack_v": last["pack_v"],
            "avg_v": last["avg_cell_v"], "soc": last["soc"], "modules": [],
            "min_cell": {"v": last["min_cell_v"]}, "max_cell": {"v": last["max_cell_v"]},
        }
        self._post_or_update(channel, ts, render_dashboard(snap, derived, None, "stale"))


# --- HTTP receiver (stdlib, no extra deps) ----------------------------------

def start_http_server(dashboard: ChargeDashboard, port: int, token: str | None = None):
    """Start the charging-state receiver in a daemon thread. Returns the server."""

    class _Handler(BaseHTTPRequestHandler):
        def _send(self, code: int, payload: dict):
            body = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            if self.path == "/healthz":
                self._send(200, {"ok": True})
            else:
                self._send(404, {"ok": False, "error": "not found"})

        def do_POST(self):  # noqa: N802
            if self.path != "/charging/state":
                self._send(404, {"ok": False, "error": "not found"})
                return
            if token and self.headers.get("X-Charge-Token") != token:
                self._send(401, {"ok": False, "error": "unauthorized"})
                return
            try:
                length = int(self.headers.get("Content-Length", 0))
                snap = json.loads(self.rfile.read(length) or b"{}")
            except Exception as e:  # noqa: BLE001
                self._send(400, {"ok": False, "error": f"bad json: {e}"})
                return
            try:
                dashboard.handle(snap)
            except Exception as e:  # noqa: BLE001
                print(f"⚡ charge dashboard handle error: {e}")
                self._send(500, {"ok": False, "error": "internal"})
                return
            self._send(200, {"ok": True})

        def log_message(self, *args):  # silence default per-request stderr logging
            return

    server = ThreadingHTTPServer(("0.0.0.0", port), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"🔌 Charge dashboard HTTP receiver listening on :{port} "
          f"(auth {'on' if token else 'OFF'})")
    return server
