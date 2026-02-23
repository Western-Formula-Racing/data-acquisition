import asyncio
import redis.asyncio as redis
import websockets
import os
import signal
import logging

logger = logging.getLogger("WebSocketBridge")

# Config
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
REDIS_CHANNEL = "can_messages"
REDIS_STATS_CHANNEL = "system_stats"
REDIS_DIAG_CHANNEL = "link_diagnostics"
WS_PORT = int(os.getenv("WS_PORT", 9080))

connected_clients = set()
shutdown_event = asyncio.Event()

async def redis_listener():
    """Listens to Redis and broadcasts to all WS clients."""
    try:
        r = redis.from_url(REDIS_URL)
        pubsub = r.pubsub()
        await pubsub.subscribe(REDIS_CHANNEL, REDIS_STATS_CHANNEL, REDIS_DIAG_CHANNEL)
        logger.info(f"Subscribed to Redis channels: {REDIS_CHANNEL}, {REDIS_STATS_CHANNEL}, {REDIS_DIAG_CHANNEL}")

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

async def ws_handler(websocket):
    """Manages WebSocket connections."""
    connected_clients.add(websocket)
    client_info = f"{websocket.remote_address[0]}:{websocket.remote_address[1]}"
    logger.info(f"Client connected: {client_info}. Total: {len(connected_clients)}")
    
    try:
        await websocket.wait_closed()
    except Exception as e:
        logger.error(f"Error while waiting for websocket {client_info} to close: {e}")
    finally:
        connected_clients.remove(websocket)
        logger.info(f"Client disconnected: {client_info}. Total: {len(connected_clients)}")

async def run_websocket_bridge(heartbeat_event=None):
    """Main entry point for WebSocket bridge."""
    loop = asyncio.get_running_loop()

    # Handle graceful shutdown
    def handle_signal():
        logger.info("Shutting down WebSocket bridge...")
        shutdown_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, handle_signal)

    async def heartbeat():
        while not shutdown_event.is_set():
            if heartbeat_event is not None:
                heartbeat_event.set()
            await asyncio.sleep(1)

    logger.info(f"Starting WebSocket Bridge on port {WS_PORT}...")

    # Start WebSocket server
    async with websockets.serve(ws_handler, "0.0.0.0", WS_PORT):
        logger.info(f"WebSocket server running at ws://0.0.0.0:{WS_PORT}")

        # Run Redis listener and heartbeat until shutdown
        await asyncio.gather(redis_listener(), heartbeat())

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    try:
        asyncio.run(run_websocket_bridge())
    except KeyboardInterrupt:
        logger.info("Keyboard interrupt received, exiting...")
