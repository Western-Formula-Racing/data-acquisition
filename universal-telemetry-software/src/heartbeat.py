"""
Heartbeat writer — publishes a per-process liveness key to Redis every second
so Redis pub/sub subscribers can detect a half-dead producer (TCP up, subscription
state lost) and reconnect. See docs/superpowers/plans/2026-06-11-stack-resilience.md.
"""
import asyncio
import json
import logging
import time

from .config import REDIS_HEARTBEAT_KEY
from .redis_utils import get_async_client

logger = logging.getLogger(__name__)

HEARTBEAT_INTERVAL_S = 1.0


async def run_heartbeat_writer(redis_client=None) -> None:
    """Write a heartbeat key to Redis every HEARTBEAT_INTERVAL_S.

    Stops on cancellation; logs and exits on any other exception so the surrounding
    supervisor (systemd / Docker) can restart the process. Skips silently if
    no Redis client is available (car mode without Redis).
    """
    if redis_client is None:
        return
    start_mono = time.monotonic()
    while True:
        try:
            payload = json.dumps({"uptime_s": time.monotonic() - start_mono,
                                   "wall_ts": time.time()})
            await redis_client.set(REDIS_HEARTBEAT_KEY, payload, ex=30)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning(f"Heartbeat write failed: {e}")
        await asyncio.sleep(HEARTBEAT_INTERVAL_S)
