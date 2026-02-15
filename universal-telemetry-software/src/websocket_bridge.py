import asyncio
import redis.asyncio as redis
import websockets
import os
import signal
import logging
import json
import time

logger = logging.getLogger("WebSocketBridge")

# Config
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
REDIS_CHANNEL = "can_messages"
REDIS_STATS_CHANNEL = "system_stats"
REDIS_UPLINK_CHANNEL = "can_uplink"
WS_PORT = int(os.getenv("WS_PORT", 9080))
ENABLE_UPLINK = os.getenv("ENABLE_UPLINK", "false").lower() == "true"
UPLINK_RATE_LIMIT = int(os.getenv("UPLINK_RATE_LIMIT", 10))  # messages per second per client

connected_clients = set()
shutdown_event = asyncio.Event()

# Per-client rate limiting state: websocket -> list of timestamps
_client_send_times: dict = {}


def _check_rate_limit(ws) -> bool:
    """Return True if the client is within the rate limit, False if exceeded."""
    now = time.monotonic()
    window = _client_send_times.setdefault(ws, [])
    # Purge entries older than 1 second
    window[:] = [t for t in window if now - t < 1.0]
    if len(window) >= UPLINK_RATE_LIMIT:
        return False
    window.append(now)
    return True


def _validate_can_send(msg: dict) -> str | None:
    """Validate a can_send message. Returns error string or None if valid."""
    ref = msg.get("ref")
    if not ref or not isinstance(ref, str) or len(ref) > 64:
        return "INVALID_REF"

    can_id = msg.get("canId")
    if can_id is None or not isinstance(can_id, int) or can_id < 0:
        return "INVALID_CAN_ID"

    data = msg.get("data")
    if not isinstance(data, list) or len(data) < 1 or len(data) > 8:
        return "INVALID_DATA"
    if not all(isinstance(b, int) and 0 <= b <= 255 for b in data):
        return "INVALID_DATA"

    return None


_ERROR_MESSAGES = {
    "INVALID_MESSAGE": "Could not parse message or missing 'type' field",
    "INVALID_CAN_ID": "canId must be a non-negative integer",
    "INVALID_DATA": "data must be an array of 1-8 integers in [0, 255]",
    "INVALID_REF": "ref must be a non-empty string (max 64 chars)",
    "BATCH_TOO_LARGE": "can_send_batch exceeds 20 messages",
    "RATE_LIMITED": f"Uplink rate limit exceeded (max {UPLINK_RATE_LIMIT} msg/sec)",
    "UPLINK_DISABLED": "Uplink is not enabled on this server",
    "UNKNOWN_TYPE": "Unrecognized message type",
}


async def redis_listener():
    """Listens to Redis and broadcasts to all WS clients."""
    try:
        r = redis.from_url(REDIS_URL)
        pubsub = r.pubsub()
        await pubsub.subscribe(REDIS_CHANNEL, REDIS_STATS_CHANNEL)
        logger.info(f"Subscribed to Redis channels: {REDIS_CHANNEL}, {REDIS_STATS_CHANNEL}")

        async for message in pubsub.listen():
            if shutdown_event.is_set():
                break

            if message['type'] == 'message':
                data = message['data']
                if isinstance(data, bytes):
                    data = data.decode('utf-8')

                # Broadcast to all connected clients
                if connected_clients:
                    # Create tasks for sending to each client to avoid blocking
                    await asyncio.gather(
                        *[client.send(data) for client in connected_clients],
                        return_exceptions=True
                    )
    except Exception as e:
        logger.error(f"Redis error: {e}")
    finally:
        logger.info("Redis listener stopping...")


async def _handle_client_message(websocket, raw: str, redis_client):
    """Process a single inbound message from a WebSocket client."""
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        await websocket.send(json.dumps({
            "type": "error",
            "code": "INVALID_MESSAGE",
            "message": _ERROR_MESSAGES["INVALID_MESSAGE"],
        }))
        return

    msg_type = msg.get("type") if isinstance(msg, dict) else None

    if msg_type == "ping":
        await websocket.send(json.dumps({
            "type": "pong",
            "timestamp": msg.get("timestamp"),
            "serverTime": int(time.time() * 1000),
        }))
        return

    if msg_type == "subscribe":
        # Future: track per-client format preference
        return

    # --- Uplink messages below here ---

    if msg_type not in ("can_send", "can_send_batch"):
        await websocket.send(json.dumps({
            "type": "error",
            "code": "UNKNOWN_TYPE",
            "message": _ERROR_MESSAGES["UNKNOWN_TYPE"],
        }))
        return

    if not ENABLE_UPLINK:
        await websocket.send(json.dumps({
            "type": "error",
            "code": "UPLINK_DISABLED",
            "message": _ERROR_MESSAGES["UPLINK_DISABLED"],
        }))
        return

    if not _check_rate_limit(websocket):
        await websocket.send(json.dumps({
            "type": "error",
            "code": "RATE_LIMITED",
            "message": _ERROR_MESSAGES["RATE_LIMITED"],
        }))
        return

    client_info = f"{websocket.remote_address[0]}:{websocket.remote_address[1]}"

    if msg_type == "can_send":
        error_code = _validate_can_send(msg)
        if error_code:
            await websocket.send(json.dumps({
                "type": "error",
                "code": error_code,
                "message": _ERROR_MESSAGES[error_code],
            }))
            return

        uplink_payload = json.dumps({
            "ref": msg["ref"],
            "canId": msg["canId"],
            "data": msg["data"],
            "source": client_info,
            "timestamp": int(time.time() * 1000),
        })
        await redis_client.publish(REDIS_UPLINK_CHANNEL, uplink_payload)
        logger.info(f"Uplink CAN send from {client_info}: canId={msg['canId']} ref={msg['ref']}")

        await websocket.send(json.dumps({
            "type": "uplink_ack",
            "ref": msg["ref"],
            "status": "queued",
            "reason": None,
        }))

    elif msg_type == "can_send_batch":
        ref = msg.get("ref")
        if not ref or not isinstance(ref, str) or len(ref) > 64:
            await websocket.send(json.dumps({
                "type": "error",
                "code": "INVALID_REF",
                "message": _ERROR_MESSAGES["INVALID_REF"],
            }))
            return

        messages = msg.get("messages", [])
        if not isinstance(messages, list) or len(messages) > 20:
            await websocket.send(json.dumps({
                "type": "error",
                "code": "BATCH_TOO_LARGE",
                "message": _ERROR_MESSAGES["BATCH_TOO_LARGE"],
            }))
            return

        # Validate each message in the batch
        for i, sub_msg in enumerate(messages):
            sub_msg["ref"] = f"{ref}/{i}"  # Assign sub-ref for validation
            error_code = _validate_can_send(sub_msg)
            if error_code:
                await websocket.send(json.dumps({
                    "type": "error",
                    "code": error_code,
                    "message": f"Message {i}: {_ERROR_MESSAGES[error_code]}",
                }))
                return

        # All valid — publish each
        now = int(time.time() * 1000)
        for i, sub_msg in enumerate(messages):
            uplink_payload = json.dumps({
                "ref": f"{ref}/{i}",
                "canId": sub_msg["canId"],
                "data": sub_msg["data"],
                "source": client_info,
                "timestamp": now,
            })
            await redis_client.publish(REDIS_UPLINK_CHANNEL, uplink_payload)

        logger.info(f"Uplink CAN batch from {client_info}: {len(messages)} msgs ref={ref}")

        await websocket.send(json.dumps({
            "type": "uplink_ack",
            "ref": ref,
            "status": "queued",
            "reason": None,
        }))


async def ws_handler(websocket):
    """Manages WebSocket connections — reads client messages for uplink."""
    connected_clients.add(websocket)
    client_info = f"{websocket.remote_address[0]}:{websocket.remote_address[1]}"
    logger.info(f"Client connected: {client_info}. Total: {len(connected_clients)}")

    redis_client = None
    if ENABLE_UPLINK:
        try:
            redis_client = redis.from_url(REDIS_URL)
            await redis_client.ping()
        except Exception as e:
            logger.error(f"Uplink Redis connection failed for {client_info}: {e}")
            redis_client = None

    try:
        async for raw_message in websocket:
            try:
                await _handle_client_message(websocket, raw_message, redis_client)
            except Exception as e:
                logger.error(f"Error handling message from {client_info}: {e}")
    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        logger.error(f"Error in ws_handler for {client_info}: {e}")
    finally:
        connected_clients.discard(websocket)
        _client_send_times.pop(websocket, None)
        if redis_client:
            await redis_client.aclose()
        logger.info(f"Client disconnected: {client_info}. Total: {len(connected_clients)}")


async def run_websocket_bridge():
    """Main entry point for WebSocket bridge."""
    loop = asyncio.get_running_loop()

    # Handle graceful shutdown
    def handle_signal():
        logger.info("Shutting down WebSocket bridge...")
        shutdown_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, handle_signal)

    logger.info(f"Starting WebSocket Bridge on port {WS_PORT}...")
    if ENABLE_UPLINK:
        logger.info(f"Uplink ENABLED (rate limit: {UPLINK_RATE_LIMIT} msg/sec/client)")
    else:
        logger.info("Uplink DISABLED (set ENABLE_UPLINK=true to enable)")

    # Start WebSocket server
    async with websockets.serve(ws_handler, "0.0.0.0", WS_PORT):
        logger.info(f"WebSocket server running at ws://0.0.0.0:{WS_PORT}")

        # Run Redis listener until shutdown
        await redis_listener()

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    try:
        asyncio.run(run_websocket_bridge())
    except KeyboardInterrupt:
        logger.info("Keyboard interrupt received, exiting...")
