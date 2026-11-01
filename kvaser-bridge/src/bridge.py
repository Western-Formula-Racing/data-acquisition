"""
Core bridge: Kvaser CAN bus -> local WebSocket server -> dashboard.

Runs a local WebSocket server that broadcasts CAN frames as JSON.
The dashboard connects to this server (via custom WS URL in settings).

Message format (same as the production broadcast server):
  { "time": <ms>, "canId": <int>, "data": [<byte>, ...] }
"""

from __future__ import annotations
import asyncio
import dataclasses
import http
import json
import logging
import pathlib
import ssl
import threading
import time
from enum import Enum, auto
from typing import Callable

import can
import websockets
from websockets.server import serve


def open_maccan_bus(channel, bitrate: int) -> can.BusABC:
    """Open a CAN bus via the maccan interface (macOS, Peak USB adapter)."""
    return can.interface.Bus(interface='maccan', channel=channel, bitrate=bitrate)

import config

# TLS cert/key: bundled with PyInstaller (sys._MEIPASS) or alongside this file
import sys as _sys
_BUNDLE = pathlib.Path(getattr(_sys, '_MEIPASS', pathlib.Path(__file__).parent))
CERT_FILE = _BUNDLE / 'bridge.crt'
KEY_FILE  = _BUNDLE / 'bridge.key'


def _make_ssl_context() -> ssl.SSLContext:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=CERT_FILE, keyfile=KEY_FILE)
    return ctx

log = logging.getLogger(__name__)


def _trust_page_html(wss_url: str) -> str:
    """HTML served on a plain HTTPS GET to the bridge.

    A browser hitting https://<bridge> (not a WebSocket upgrade) lands here
    after the user clicks through the self-signed cert warning. The page
    confirms the certificate is now trusted and live-tests the wss:// link
    back to the bridge so the user gets real "it works" feedback instead of
    a blank/error page.
    """
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kvaser Bridge — Certificate Trusted</title>
<style>
  :root {{ color-scheme: dark; }}
  body {{ margin:0; font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
         background:#0f1115; color:#e7eaf0; display:flex; min-height:100vh;
         align-items:center; justify-content:center; padding:24px; box-sizing:border-box; }}
  .card {{ background:#171a21; border:1px solid #262b36; border-radius:16px; padding:32px;
          max-width:460px; width:100%; box-shadow:0 10px 40px rgba(0,0,0,.4); }}
  .check {{ width:56px; height:56px; border-radius:50%; background:#13301f;
           border:1px solid #1f7a45; display:flex; align-items:center; justify-content:center;
           margin-bottom:18px; font-size:30px; color:#34d27b; }}
  h1 {{ font-size:20px; margin:0 0 8px; }}
  p {{ margin:0 0 14px; color:#aab2c0; line-height:1.5; font-size:14px; }}
  code {{ background:#0f1115; border:1px solid #262b36; border-radius:6px; padding:2px 6px;
         font-size:13px; color:#cdd3de; word-break:break-all; }}
  .status {{ margin-top:18px; padding:12px 14px; border-radius:10px; font-size:14px;
            display:flex; align-items:center; gap:10px; border:1px solid #262b36; background:#0f1115; }}
  .dot {{ width:10px; height:10px; border-radius:50%; background:#8a93a3; flex:none; }}
  .dot.ok {{ background:#34d27b; box-shadow:0 0 0 4px rgba(52,210,123,.15); }}
  .dot.bad {{ background:#f0683a; box-shadow:0 0 0 4px rgba(240,104,58,.15); }}
  .hint {{ font-size:12px; color:#7f8896; margin-top:16px; }}
</style>
</head>
<body>
  <div class="card">
    <div class="check">✓</div>
    <h1>Certificate trusted</h1>
    <p>This browser now trusts the Kvaser Bridge. You can close this tab and
       return to your PECAN dashboard — the connection will work.</p>
    <p>Bridge URL (already filled in for you on the dashboard):<br><code>{wss_url}</code></p>
    <div class="status"><span class="dot" id="dot"></span><span id="msg">Testing live connection…</span></div>
    <p class="hint">You only need to do this once per browser. If the test below fails,
       make sure the bridge is running and that you opened this page in the same
       browser you use for the dashboard.</p>
  </div>
<script>
  var url = {json.dumps(wss_url)};
  var dot = document.getElementById('dot');
  var msg = document.getElementById('msg');
  try {{
    var ws = new WebSocket(url);
    var done = false;
    var t = setTimeout(function() {{
      if (done) return; done = true;
      dot.className = 'dot bad'; msg.textContent = 'No response yet — is the bridge running?';
      try {{ ws.close(); }} catch (e) {{}}
    }}, 4000);
    ws.onopen = function() {{
      if (done) return; done = true; clearTimeout(t);
      dot.className = 'dot ok'; msg.textContent = 'Live connection to the bridge confirmed.';
      ws.close();
    }};
    ws.onerror = function() {{
      if (done) return; done = true; clearTimeout(t);
      dot.className = 'dot bad'; msg.textContent = 'Could not reach the bridge over wss://.';
    }};
  }} catch (e) {{
    dot.className = 'dot bad'; msg.textContent = 'Browser blocked the test connection.';
  }}
</script>
</body>
</html>"""


_UDEV_RULE = 'SUBSYSTEM=="net", KERNEL=="can*", GROUP="netdev", MODE="0660"'
_UDEV_PATH = pathlib.Path('/etc/udev/rules.d/80-can.rules')


def _socketcan_setup(channel: str, bitrate: int) -> None:
    """Bring up a SocketCAN interface, installing udev rule + requesting
    privilege escalation via pkexec/sudo if needed."""
    import subprocess, grp, os, shlex

    def _run(cmd: list[str], privileged: bool = False) -> subprocess.CompletedProcess:
        if privileged:
            # Try without privilege first; fall back to pkexec (GUI prompt) then sudo
            r = subprocess.run(cmd, capture_output=True)
            if r.returncode == 0:
                return r
            for elevator in (['pkexec'], ['sudo']):
                r = subprocess.run(elevator + cmd, capture_output=True)
                if r.returncode == 0:
                    return r
            raise RuntimeError(f"Command failed (tried pkexec/sudo): {' '.join(cmd)}\n{r.stderr.decode()}")
        return subprocess.run(cmd, capture_output=True)

    # Install udev rule on first run so future plug-ins work without privilege
    if not _UDEV_PATH.exists():
        log.info('Installing udev rule for CAN interfaces (one-time setup)...')
        try:
            rule_bytes = (_UDEV_RULE + '\n').encode()
            # Write via tee with privilege
            r = subprocess.run(
                ['pkexec', 'tee', str(_UDEV_PATH)],
                input=rule_bytes, capture_output=True,
            )
            if r.returncode != 0:
                subprocess.run(['sudo', 'tee', str(_UDEV_PATH)], input=rule_bytes, capture_output=True, check=True)
            subprocess.run(['sudo', 'udevadm', 'control', '--reload-rules'], capture_output=True)
            subprocess.run(['sudo', 'udevadm', 'trigger'], capture_output=True)
            # Add user to netdev group
            try:
                grp.getgrnam('netdev')
                subprocess.run(['sudo', 'usermod', '-aG', 'netdev', os.environ.get('USER', os.getlogin())], capture_output=True)
            except KeyError:
                pass
            log.info('udev rule installed.')
        except Exception as e:
            log.warning('Could not install udev rule: %s', e)

    # Bring the interface down first (ignore errors if already down)
    subprocess.run(['ip', 'link', 'set', channel, 'down'], capture_output=True)

    # Bring up with bitrate
    r = subprocess.run(
        ['ip', 'link', 'set', channel, 'up', 'type', 'can', 'bitrate', str(bitrate)],
        capture_output=True,
    )
    if r.returncode != 0:
        log.info('ip link requires privilege, requesting elevation...')
        _run(['ip', 'link', 'set', channel, 'down'], privileged=True)
        _run(['ip', 'link', 'set', channel, 'up', 'type', 'can', 'bitrate', str(bitrate)], privileged=True)

    log.info('SocketCAN interface %s up at %d bps', channel, bitrate)

class BridgeState(Enum):
    IDLE    = auto()
    OPEN    = auto()
    ERROR   = auto()


@dataclasses.dataclass
class BridgeStatus:
    state:         BridgeState = BridgeState.IDLE
    channel:       int         = config.DEFAULT_CHANNEL
    bitrate:       int         = config.DEFAULT_BITRATE
    ws_port:       int         = config.DEFAULT_WS_PORT
    frames_rx:     int         = 0
    frames_tx:     int         = 0
    clients:       int         = 0
    error_msg:     str         = ''
    can_interface: str         = config.DEFAULT_CAN_INTERFACE
    tls:           bool        = True


class Bridge:
    """
    Reads CAN frames from the Kvaser/socketcan bus and broadcasts them
    to all connected WebSocket clients via a local server.
    """

    def __init__(self, channel: int, bitrate: int, ws_port: int, can_interface: str, tls: bool = True) -> None:
        self._channel = channel
        self._bitrate = bitrate
        self._ws_port = ws_port
        self._can_interface = can_interface
        self._tls = tls

        self._bus: can.BusABC | None = None
        self._clients: set = set()
        self._server = None

        self._status      = BridgeStatus(channel=channel, bitrate=bitrate, ws_port=ws_port, can_interface=can_interface, tls=tls)
        self._status_lock = threading.Lock()

        self._running  = False
        self._tasks:   list[asyncio.Task] = []

        self.on_status_change: Callable[[BridgeStatus], None] | None = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def start(self) -> None:
        if self._running:
            return
        self._running = True

        # Open CAN bus
        try:
            if self._can_interface == 'socketcan':
                ch = config.DEFAULT_SOCKETCAN_CHANNEL
                _socketcan_setup(ch, self._bitrate)
                self._bus = can.interface.Bus(channel=ch, interface='socketcan')
            elif self._can_interface == 'vcan':
                # Virtual CAN interface — already up (created by simulation-bridge/setup_vcan.sh).
                # No ip-link setup needed; vcan interfaces don't have a hardware bitrate.
                self._bus = can.interface.Bus(
                    channel=config.DEFAULT_VCAN_CHANNEL,
                    interface='socketcan',
                )
            elif self._can_interface == 'maccan':
                self._bus = open_maccan_bus(channel=self._channel, bitrate=self._bitrate)
            else:
                self._bus = can.interface.Bus(
                    interface='kvaser',
                    channel=self._channel,
                    bitrate=self._bitrate,
                )
            log.info('CAN bus opened: interface=%s bitrate=%d', self._can_interface, self._bitrate)
        except Exception as e:
            log.error('Failed to open CAN bus: %s', e)
            self._set_state(BridgeState.ERROR, str(e))
            self._running = False
            return

        # Start local WebSocket server (TLS or plain depending on config)
        try:
            ssl_ctx = _make_ssl_context() if self._tls else None
            self._server = await serve(
                self._ws_handler,
                '0.0.0.0',
                self._ws_port,
                ssl=ssl_ctx,
                process_request=self._http_process_request,
            )
            scheme = 'wss' if self._tls else 'ws'
            log.info('WebSocket server listening on %s://0.0.0.0:%d', scheme, self._ws_port)
        except Exception as e:
            log.error('Failed to start WebSocket server: %s', e)
            self._close_bus()
            self._set_state(BridgeState.ERROR, f'WS server: {e}')
            self._running = False
            return

        self._set_state(BridgeState.OPEN)
        self._tasks = [
            asyncio.create_task(self._can_read_loop()),
        ]

    async def stop(self) -> None:
        self._running = False
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = []

        # Close all client connections before waiting for server to close,
        # otherwise wait_closed() hangs waiting for connections to finish.
        for ws in list(self._clients):
            try:
                await ws.close()
            except Exception:
                pass
        self._clients.clear()

        if self._server:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

        self._close_bus()
        with self._status_lock:
            self._status.clients = 0
        self._set_state(BridgeState.IDLE)
        log.info('Bridge stopped')

    def set_channel(self, channel: int) -> None:
        self._channel = channel
        with self._status_lock:
            self._status.channel = channel

    def set_bitrate(self, bitrate: int) -> None:
        self._bitrate = bitrate
        with self._status_lock:
            self._status.bitrate = bitrate

    def set_ws_port(self, port: int) -> None:
        self._ws_port = port
        with self._status_lock:
            self._status.ws_port = port

    def set_can_interface(self, iface: str) -> None:
        self._can_interface = iface
        with self._status_lock:
            self._status.can_interface = iface

    def get_status(self) -> BridgeStatus:
        with self._status_lock:
            return dataclasses.replace(self._status)

    # ------------------------------------------------------------------
    # WebSocket server handler
    # ------------------------------------------------------------------

    async def _http_process_request(self, path, request_headers):
        """Intercept plain HTTP(S) GETs (not WebSocket upgrades) and serve a
        human-friendly cert-trust confirmation page.

        Returning None lets a genuine WebSocket handshake proceed. A browser
        opening https://<bridge> to accept the self-signed cert sends a normal
        GET (no `Upgrade: websocket`), so we answer with a 200 success page
        instead of the opaque 426/400 the WS server would otherwise return.
        """
        upgrade = request_headers.get('Upgrade', '')
        if upgrade.lower() == 'websocket':
            return None  # real client — continue the WebSocket handshake

        host = request_headers.get('Host') or f'localhost:{self._ws_port}'
        scheme = 'wss' if self._tls else 'ws'
        wss_url = f'{scheme}://{host}'
        body = _trust_page_html(wss_url).encode('utf-8')
        headers = [
            ('Content-Type', 'text/html; charset=utf-8'),
            ('Content-Length', str(len(body))),
            ('Cache-Control', 'no-store'),
        ]
        return http.HTTPStatus.OK, headers, body

    async def _ws_handler(self, websocket) -> None:
        """Handle a new dashboard client connection."""
        self._clients.add(websocket)
        with self._status_lock:
            self._status.clients = len(self._clients)
        self._notify()
        log.info('Dashboard client connected (%d total)', len(self._clients))

        try:
            # Keep connection alive; handle incoming messages (ping or CAN TX)
            loop = asyncio.get_event_loop()
            async for message in websocket:
                try:
                    data = json.loads(message)
                    if not isinstance(data, dict):
                        continue
                    msg_type = data.get('type')
                    if msg_type == 'ping':
                        await websocket.send(json.dumps({
                            'type': 'pong',
                            'server_ts': int(time.time() * 1000),
                        }))
                    elif msg_type == 'tx' and self._bus is not None:
                        # Dashboard → CAN bus: {"type": "tx", "canId": N, "data": [...]}
                        can_id = int(data['canId'])
                        payload = bytes(data['data'])
                        if len(payload) > 8:
                            continue
                        frame = can.Message(
                            arbitration_id=can_id,
                            data=payload,
                            is_extended_id=can_id > 0x7FF,
                        )
                        await loop.run_in_executor(None, self._bus.send, frame)
                        with self._status_lock:
                            self._status.frames_tx += 1
                        self._notify()
                except Exception:
                    pass
        except websockets.ConnectionClosed:
            pass
        finally:
            self._clients.discard(websocket)
            with self._status_lock:
                self._status.clients = len(self._clients)
            self._notify()
            log.info('Dashboard client disconnected (%d remaining)', len(self._clients))

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _notify(self) -> None:
        if self.on_status_change:
            self.on_status_change(self.get_status())

    def _set_state(self, state: BridgeState, error_msg: str = '') -> None:
        with self._status_lock:
            self._status.state     = state
            self._status.error_msg = error_msg
        self._notify()

    def _close_bus(self) -> None:
        if self._bus is not None:
            try:
                self._bus.shutdown()
            except Exception:
                pass
            self._bus = None

    async def _can_read_loop(self) -> None:
        """Read CAN frames and broadcast as JSON to all connected clients."""
        loop = asyncio.get_event_loop()
        batch: list[dict] = []
        last_send = time.monotonic()

        while self._running:
            try:
                msg = await loop.run_in_executor(
                    None, self._bus.recv, 0.05
                )

                if msg is not None:
                    frame = {
                        'time': int(time.time() * 1000),
                        'canId': msg.arbitration_id,
                        'data': list(msg.data),
                    }
                    batch.append(frame)
                    with self._status_lock:
                        self._status.frames_rx += 1

                # Broadcast every 50ms or when we have 50+ frames
                now = time.monotonic()
                if batch and (now - last_send >= 0.05 or len(batch) >= 50):
                    await self._broadcast(batch)
                    batch = []
                    last_send = now

                    # Update UI periodically
                    self._notify()

            except asyncio.CancelledError:
                break
            except Exception as e:
                log.error('CAN read error: %s', e)
                self._set_state(BridgeState.ERROR, str(e))
                self._running = False
                break

        # Flush remaining
        if batch:
            await self._broadcast(batch)

    async def _broadcast(self, batch: list[dict]) -> None:
        """Send a batch of frames to all connected clients."""
        if not self._clients:
            return
        payload = json.dumps(batch)
        dead = set()
        for ws in list(self._clients):
            try:
                await ws.send(payload)
            except Exception:
                dead.add(ws)
        if dead:
            self._clients -= dead
            with self._status_lock:
                self._status.clients = len(self._clients)
