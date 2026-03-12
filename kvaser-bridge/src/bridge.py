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


class BridgeState(Enum):
    IDLE    = auto()
    OPEN    = auto()
    ERROR   = auto()


@dataclasses.dataclass
class BridgeStatus:
    state:       BridgeState = BridgeState.IDLE
    channel:     int         = config.DEFAULT_CHANNEL
    bitrate:     int         = config.DEFAULT_BITRATE
    ws_port:     int         = config.DEFAULT_WS_PORT
    frames_rx:   int         = 0
    clients:     int         = 0
    error_msg:   str         = ''


class Bridge:
    """
    Reads CAN frames from the Kvaser/socketcan bus and broadcasts them
    to all connected WebSocket clients via a local server.
    """

    def __init__(self, channel: int, bitrate: int, ws_port: int) -> None:
        self._channel = channel
        self._bitrate = bitrate
        self._ws_port = ws_port

        self._bus: can.BusABC | None = None
        self._clients: set = set()
        self._server = None

        self._status      = BridgeStatus(channel=channel, bitrate=bitrate, ws_port=ws_port)
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
            if config.DEFAULT_CAN_INTERFACE == 'socketcan':
                ch = config.DEFAULT_SOCKETCAN_CHANNEL
                # can0 is expected to be already up (via udev rule or manually).
                # See README: install /etc/udev/rules.d/80-can.rules to auto-bring up on plug-in.
                self._bus = can.interface.Bus(channel=ch, interface='socketcan')
            else:
                self._bus = can.interface.Bus(
                    interface='kvaser',
                    channel=self._channel,
                    bitrate=self._bitrate,
                )
            log.info('CAN bus opened: interface=%s bitrate=%d', config.DEFAULT_CAN_INTERFACE, self._bitrate)
        except Exception as e:
            log.error('Failed to open CAN bus: %s', e)
            self._set_state(BridgeState.ERROR, str(e))
            self._running = False
            return

        # Start local WebSocket server (WSS with bundled self-signed cert)
        try:
            ssl_ctx = _make_ssl_context()
            self._server = await serve(
                self._ws_handler,
                '0.0.0.0',
                self._ws_port,
                ssl=ssl_ctx,
            )
            log.info('WebSocket server listening on wss://0.0.0.0:%d', self._ws_port)
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

        if self._server:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

        # Close all client connections
        for ws in list(self._clients):
            try:
                await ws.close()
            except Exception:
                pass
        self._clients.clear()

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

    def get_status(self) -> BridgeStatus:
        with self._status_lock:
            return dataclasses.replace(self._status)

    # ------------------------------------------------------------------
    # WebSocket server handler
    # ------------------------------------------------------------------

    async def _ws_handler(self, websocket) -> None:
        """Handle a new dashboard client connection."""
        self._clients.add(websocket)
        with self._status_lock:
            self._status.clients = len(self._clients)
        self._notify()
        log.info('Dashboard client connected (%d total)', len(self._clients))

        try:
            # Keep connection alive; handle any incoming messages (e.g. ping)
            async for message in websocket:
                try:
                    data = json.loads(message)
                    if isinstance(data, dict) and data.get('type') == 'ping':
                        await websocket.send(json.dumps({
                            'type': 'pong',
                            'server_ts': int(time.time() * 1000),
                        }))
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
