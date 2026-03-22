"""
TX WebSocket Bridge — Signal-based CAN transmission.

Handles two message types from the PECAN Transmitter page:
  - can_preview_signals : compute encoded bytes from signal values (no CAN bus write)
  - can_send_signals    : compute encoded bytes + write to CAN bus

Uses python-can + cantools to encode signal -> CAN payload using the DBC.
OFF by default (ENABLE_TX_WS=true to enable). Runs on port 9078.

Safety properties:
  - Separate port from RX WebSocket (9080)
  - OFF by default
  - can_preview_signals NEVER writes to CAN bus
  - can_send_signals requires ENABLE_TX_WS=true
"""

import asyncio
import logging
import json
import os
import signal
import time

import websockets
import cantools
import can

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger("TxBridge")

# ── Config ────────────────────────────────────────────────────────────────────

TX_WS_PORT = int(os.getenv("TX_WS_PORT", "9078"))
ENABLE_TX_WS = os.getenv("ENABLE_TX_WS", "false").lower() == "true"
DBC_FILE_PATH = os.getenv("DBC_FILE_PATH", "/app/example.dbc")
UPLINK_RATE_LIMIT = int(os.getenv("UPLINK_RATE_LIMIT", "10"))

# ── DBC / CAN bus (lazy init) ────────────────────────────────────────────────

_can_bus = None
_db = None  # cantools database


def _init_dbc():
    """Load the DBC file once on startup."""
    global _db
    if _db is not None:
        return
    try:
        _db = cantools.database.load_file(DBC_FILE_PATH)
        logger.info(f"DBC loaded from {DBC_FILE_PATH}: {len(_db.messages)} messages")
    except Exception as e:
        logger.error(f"Failed to load DBC from {DBC_FILE_PATH}: {e}")
        raise


def _init_can_bus():
    """Open CAN bus for writing (car mode)."""
    global _can_bus
    if _can_bus is not None:
        return
    if os.getenv("SIMULATE", "false").lower() == "true":
        logger.info("TX CAN bus: simulation mode (no hardware)")
        return
    try:
        _can_bus = can.interface.Bus(channel="can0", bustype="socketcan")
        logger.info("TX CAN bus opened for direct writes on can0")
    except Exception as e:
        logger.warning(f"Could not open CAN bus for TX ({e}). Writes will be logged only.")


def _encode_signals(can_id: int, signals: dict):
    """Encode signal values to CAN payload bytes using cantools DBC.

    Returns (bytes, error_string) — bytes is None on error.
    """
    if _db is None:
        return None, "DBC not loaded"
    try:
        msg = _db.get_message_by_frame_id(can_id)
        # Pad missing signals with their initial value (or 0) so partial dicts work.
        # cantools strict=False is unreliable for signed signals in >=39.x.
        padded = {sig.name: (sig.initial if sig.initial is not None else 0) for sig in msg.signals}
        padded.update(signals)
        data = msg.encode(padded)
        return list(data), None
    except cantools.database.EncodeError as e:
        return None, f"ENCODE_ERROR: {e}"
    except Exception as e:
        return None, f"INTERNAL_ERROR: {e}"


def _write_can(can_id: int, data: bytes, ref: str):
    """Write encoded bytes to CAN bus. Returns error string or None."""
    if _can_bus is None:
        logger.info(f"CAN write (sim): canId={can_id} ref={ref} bytes={list(data)}")
        return None
    try:
        msg = can.Message(
            arbitration_id=can_id,
            data=data,
            is_extended_id=can_id > 0x7FF,
        )
        _can_bus.send(msg)
        logger.info(f"CAN write: canId={can_id} ref={ref}")
        return None
    except Exception as e:
        return str(e)


# ── Rate limiting ─────────────────────────────────────────────────────────────

_client_send_times: dict = {}


def _check_rate_limit(ws) -> bool:
    now = time.monotonic()
    window = _client_send_times.setdefault(ws, [])
    window[:] = [t for t in window if now - t < 1.0]
    if len(window) >= UPLINK_RATE_LIMIT:
        return False
    window.append(now)
    return True


# ── Message handlers ───────────────────────────────────────────────────────────

_ERRORS = {
    "INVALID_MESSAGE": "Could not parse message or missing 'type' field",
    "INVALID_CAN_ID": "canId must be a non-negative integer",
    "INVALID_SIGNALS": "signals must be a dict of signal_name: numeric_value",
    "ENCODE_ERROR": "Failed to encode signals — check signal names and values",
    "INTERNAL_ERROR": "Internal encoding error",
    "TX_DISABLED": "TX bridge is disabled (set ENABLE_TX_WS=true)",
    "UNKNOWN_TYPE": "Unrecognized message type",
    "RATE_LIMITED": f"Rate limit exceeded ({UPLINK_RATE_LIMIT} msg/sec/client)",
}


async def _handle_client_message(websocket, raw: str):
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        await websocket.send(json.dumps({"type": "error", "code": "INVALID_MESSAGE", "message": _ERRORS["INVALID_MESSAGE"]}))
        return

    msg_type = msg.get("type") if isinstance(msg, dict) else None

    if msg_type == "ping":
        await websocket.send(json.dumps({"type": "pong", "timestamp": msg.get("timestamp"), "serverTime": int(time.time() * 1000)}))
        return

    if msg_type not in ("can_preview_signals", "can_send_signals"):
        await websocket.send(json.dumps({"type": "error", "code": "UNKNOWN_TYPE", "message": _ERRORS["UNKNOWN_TYPE"]}))
        return

    if not ENABLE_TX_WS:
        await websocket.send(json.dumps({"type": "error", "code": "TX_DISABLED", "message": _ERRORS["TX_DISABLED"]}))
        return

    if not _check_rate_limit(websocket):
        await websocket.send(json.dumps({"type": "error", "code": "RATE_LIMITED", "message": _ERRORS["RATE_LIMITED"]}))
        return

    # ── Validate ──────────────────────────────────────────────────────────────

    can_id = msg.get("canId")
    if not isinstance(can_id, int) or can_id < 0:
        await websocket.send(json.dumps({"type": "error", "code": "INVALID_CAN_ID", "message": _ERRORS["INVALID_CAN_ID"]}))
        return

    signals = msg.get("signals", {})
    if not isinstance(signals, dict):
        await websocket.send(json.dumps({"type": "error", "code": "INVALID_SIGNALS", "message": _ERRORS["INVALID_SIGNALS"]}))
        return

    ref = msg.get("ref", "preview")
    client_info = f"{websocket.remote_address[0]}:{websocket.remote_address[1]}"

    # ── Encode ────────────────────────────────────────────────────────────────

    try:
        _init_dbc()
    except Exception:
        await websocket.send(json.dumps({"type": "error", "code": "INTERNAL_ERROR", "message": "Failed to load DBC file"}))
        return

    data_bytes, err = _encode_signals(can_id, signals)
    if err:
        await websocket.send(json.dumps({"type": "error", "code": "ENCODE_ERROR", "message": f"{_ERRORS['ENCODE_ERROR']}: {err}"}))
        return

    # ── can_preview_signals: respond with bytes only ───────────────────────────

    if msg_type == "can_preview_signals":
        logger.debug(f"Preview from {client_info}: canId={can_id} signals={signals}")
        await websocket.send(json.dumps({
            "type": "preview",
            "ref": ref,
            "canId": can_id,
            "bytes": data_bytes,
            "ok": True,
        }))
        return

    # ── can_send_signals: encode + write to CAN bus ───────────────────────────

    if msg_type == "can_send_signals":
        _init_can_bus()
        write_err = _write_can(can_id, bytes(data_bytes), ref)

        if write_err:
            logger.error(f"CAN write failed from {client_info}: {write_err}")
            await websocket.send(json.dumps({
                "type": "error",
                "code": "CAN_WRITE_FAILED",
                "message": f"CAN bus write failed: {write_err}",
            }))
            return

        logger.info(f"TX from {client_info}: canId={can_id} ref={ref} bytes={data_bytes}")
        await websocket.send(json.dumps({
            "type": "uplink_ack",
            "ref": ref,
            "status": "sent",
            "bytes": data_bytes,
        }))


# ── WebSocket server ───────────────────────────────────────────────────────────

shutdown_event = asyncio.Event()


async def ws_handler(websocket):
    client_info = f"{websocket.remote_address[0]}:{websocket.remote_address[1]}"
    logger.info(f"TX client connected: {client_info}")

    try:
        async for raw_message in websocket:
            try:
                await _handle_client_message(websocket, raw_message)
            except Exception as e:
                logger.error(f"Error handling message from {client_info}: {e}")
    except Exception as e:
        logger.error(f"WS error for {client_info}: {e}")
    finally:
        _client_send_times.pop(websocket, None)
        logger.info(f"TX client disconnected: {client_info}")


async def run_tx_bridge():
    loop = asyncio.get_running_loop()

    def handle_signal():
        logger.info("Shutting down TX bridge...")
        shutdown_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, handle_signal)

    # Pre-load DBC on startup
    try:
        _init_dbc()
    except Exception as e:
        logger.warning(f"Could not pre-load DBC: {e}")

    if ENABLE_TX_WS:
        _init_can_bus()

    logger.info(f"Starting TX WebSocket Bridge on port {TX_WS_PORT} (ENABLE_TX_WS={ENABLE_TX_WS})")

    async with websockets.serve(ws_handler, "0.0.0.0", TX_WS_PORT):
        await shutdown_event.wait()


if __name__ == "__main__":
    try:
        asyncio.run(run_tx_bridge())
    except KeyboardInterrupt:
        logger.info("Keyboard interrupt received, exiting...")
