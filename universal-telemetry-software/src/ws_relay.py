"""
WebSocket telemetry relay — downlink-only fan-out with optional token gate.

Connects upstream to the UTS WebSocket bridge (or any compatible server) and
re-broadcasts text frames to downstream viewers. Intended for a laptop base
station: LAN clients use ws://<host>:RELAY_PORT (no token by default); traffic
via Cloudflare Tunnel (cloudflared → 127.0.0.1) sees the peer as loopback and
must present ?token= matching RELAY_TOKEN.

Run standalone:
    uv run python -m src.ws_relay

Or enable ENABLE_WS_RELAY=true in main.py (same venv / uv project).
"""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import json
import logging
import os
import secrets
import time
from urllib.parse import parse_qs, urlparse

import websockets
from websockets.asyncio.server import ServerConnection
from websockets.datastructures import Headers
from websockets.http11 import Response

from src import utils

logger = logging.getLogger("WsRelay")

# ── Env (read at startup via _config()) ─────────────────────────────────────
def _env_bool(name: str, default: str = "false") -> bool:
    return os.getenv(name, default).lower() == "true"


TOKEN_FILE = "/app/relay_token"


def _get_live_token() -> str | None:
    try:
        with open(TOKEN_FILE) as f:
            val = f.read().strip()
            return val or None
    except FileNotFoundError:
        pass
    return os.getenv("RELAY_TOKEN") or None


def _config() -> dict:
    return {
        "upstream": os.getenv("RELAY_UPSTREAM_WS", "ws://127.0.0.1:9080"),
        "listen_host": os.getenv("RELAY_LISTEN_HOST", "0.0.0.0"),
        "listen_port": int(os.getenv("RELAY_LISTEN_PORT", "9089")),
        "require_token_on_lan": _env_bool("RELAY_REQUIRE_TOKEN_ON_LAN", "false"),
        "reconnect_min": float(os.getenv("RELAY_UPSTREAM_RECONNECT_MIN", "1")),
        "reconnect_max": float(os.getenv("RELAY_UPSTREAM_RECONNECT_MAX", "30")),
    }


def token_required_for_peer(
    host: str,
    relay_token: str | None,
    require_token_on_lan: bool,
) -> bool:
    """
    Return True if the handshake must include a valid ?token= for this peer.

    Loopback (Cloudflare tunnel origin) requires token when RELAY_TOKEN is set.
    RFC1918 / link-local peers skip token unless RELAY_REQUIRE_TOKEN_ON_LAN.
    """
    if not relay_token:
        return False
    if require_token_on_lan:
        return True
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return True
    if addr.is_loopback:
        return True
    if addr.is_private or addr.is_link_local:
        return False
    return True


def _token_from_request_path(path: str) -> str | None:
    parsed = urlparse(path if path.startswith("/") else f"/{path}")
    qs = parse_qs(parsed.query)
    vals = qs.get("token")
    if not vals:
        return None
    return vals[0]


def _token_ok(expected: str, provided: str | None) -> bool:
    if provided is None:
        return False
    if len(provided) != len(expected):
        return False
    return secrets.compare_digest(expected, provided)


def _reject_401() -> Response:
    return Response(401, "Unauthorized", Headers(), b"missing or invalid token\n")


def _make_process_request(get_token, require_on_lan: bool):
    async def process_request(connection: ServerConnection, request) -> Response | None:
        host = connection.remote_address[0] if connection.remote_address else ""
        relay_token = get_token() if callable(get_token) else get_token
        if not token_required_for_peer(host, relay_token, require_on_lan):
            return None
        provided = _token_from_request_path(request.path)
        if relay_token and _token_ok(relay_token, provided):
            return None
        logger.warning("Rejected WS handshake from %s (token required)", host or "?")
        return _reject_401()

    return process_request


async def run_ws_relay(heartbeat_event=None) -> None:
    cfg = _config()
    upstream_uri = cfg["upstream"]
    host = cfg["listen_host"]
    port = cfg["listen_port"]
    require_on_lan = cfg["require_token_on_lan"]
    backoff_min = cfg["reconnect_min"]
    backoff_max = cfg["reconnect_max"]

    shutdown_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    utils.register_shutdown_signals(loop, shutdown_event, "WS relay")

    connected_clients: set = set()
    process_request = _make_process_request(_get_live_token, require_on_lan)

    async def downstream_handler(connection: ServerConnection) -> None:
        peer = connection.remote_address
        connected_clients.add(connection)
        logger.info("Downstream client connected: %s (total=%s)", peer, len(connected_clients))
        try:
            async for raw in connection:
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8", errors="replace")
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if isinstance(msg, dict) and msg.get("type") == "ping":
                    await connection.send(
                        json.dumps(
                            {
                                "type": "pong",
                                "timestamp": msg.get("timestamp"),
                                "serverTime": int(time.time() * 1000),
                            }
                        )
                    )
                # Downlink-only: do not forward uplink to upstream.
        except websockets.exceptions.ConnectionClosed:
            pass
        except Exception as e:
            logger.error("Downstream handler error from %s: %s", peer, e)
        finally:
            connected_clients.discard(connection)
            logger.info(
                "Downstream client disconnected: %s (total=%s)", peer, len(connected_clients)
            )

    async def upstream_loop() -> None:
        delay = backoff_min
        while not shutdown_event.is_set():
            try:
                logger.info("Upstream connecting: %s", upstream_uri)
                async with websockets.connect(
                    upstream_uri,
                    max_size=2**20,
                    ping_interval=20,
                    ping_timeout=20,
                ) as upstream:
                    logger.info("Upstream connected")
                    delay = backoff_min
                    async for message in upstream:
                        if shutdown_event.is_set():
                            break
                        if not connected_clients:
                            continue
                        if isinstance(message, bytes):
                            message = message.decode("utf-8", errors="replace")
                        await asyncio.gather(
                            *[c.send(message) for c in list(connected_clients)],
                            return_exceptions=True,
                        )
            except asyncio.CancelledError:
                break
            except Exception as e:
                if shutdown_event.is_set():
                    break
                logger.warning("Upstream error (%s), reconnect in %.1fs", e, delay)
                await asyncio.sleep(delay)
                delay = min(delay * 2, backoff_max)
        logger.info("Upstream loop exiting")

    logger.info(
        "WS relay listening ws://%s:%s → upstream %s (token=%s require_lan_token=%s)",
        host,
        port,
        upstream_uri,
        "set" if _get_live_token() else "off",
        require_on_lan,
    )

    async def relay_heartbeat_loop() -> None:
        while not shutdown_event.is_set():
            try:
                await asyncio.wait_for(shutdown_event.wait(), timeout=1.0)
                break
            except asyncio.TimeoutError:
                pass
            if not connected_clients:
                continue
            # Send as a CAN frame so it flows through the standard ingest path.
            # canId 0x7FE is reserved for relay heartbeat; data hex reads "DA DA AA AA DA DA AA AA".
            payload = json.dumps({
                "time": int(time.time() * 1000),
                "canId": 0x7FE,
                "data": [0xDA, 0xDA, 0xAA, 0xAA, 0xDA, 0xDA, 0xAA, 0xAA],
            })
            await asyncio.gather(
                *[c.send(payload) for c in list(connected_clients)],
                return_exceptions=True,
            )

    async with websockets.serve(
        downstream_handler,
        host,
        port,
        max_size=2**20,
        process_request=process_request,
    ):
        upstream_task = asyncio.create_task(upstream_loop())
        heartbeat_task = asyncio.create_task(relay_heartbeat_loop())
        try:
            await utils.heartbeat_coro(heartbeat_event, shutdown_event)
        finally:
            shutdown_event.set()
            upstream_task.cancel()
            heartbeat_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await upstream_task
            with contextlib.suppress(asyncio.CancelledError):
                await heartbeat_task


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )
    try:
        asyncio.run(run_ws_relay())
    except KeyboardInterrupt:
        logger.info("Keyboard interrupt, exiting")


if __name__ == "__main__":
    main()
