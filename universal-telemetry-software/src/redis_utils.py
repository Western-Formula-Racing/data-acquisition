"""
Shared Redis helpers for the telemetry stack.

Provides a consistent connection factory, a safe fire-and-forget publish
wrapper, and a message-payload decoder so every module handles errors the
same way.
"""

import logging

import redis
import redis.asyncio as aioredis

logger = logging.getLogger(__name__)


def get_sync_client(url: str, retries: int = 10, backoff: float = 1.0):
    """Return a connected synchronous Redis client, retrying on failure.

    Args:
        url: Redis connection URL.
        retries: Maximum connection attempts before giving up (default 10).
        backoff: Seconds to wait between retries, multiplied by 1.5 each attempt.
                 With default values: ~25s total (1+1.5+2.25+3.375+...).
    """
    client = redis.from_url(url)
    attempt = 0
    while True:
        attempt += 1
        try:
            client.ping()
            logger.info(f"Connected to Redis (attempt {attempt})")
            return client
        except Exception as e:
            if attempt >= retries:
                logger.warning(
                    f"Could not connect to Redis after {retries} attempts: {e}. "
                    "Data will not be published to Redis."
                )
                return None
            wait = backoff * (1.5 ** (attempt - 1))
            logger.info(f"Redis connection attempt {attempt}/{retries} failed ({e}), "
                         f"retrying in {wait:.1f}s...")
            import time
            time.sleep(wait)


def get_async_client(url: str):
    """Return an async Redis client (no ping — call aclose() when done)."""
    return aioredis.from_url(url)


def safe_publish(client, channel: str, data: str, module_logger=None) -> None:
    """Publish *data* to *channel*, swallowing and logging any errors."""
    _log = module_logger or logger
    if client:
        try:
            client.publish(channel, data)
        except Exception as e:
            _log.error(f"Redis publish error: {e}")


def decode_message(data) -> str:
    """Decode a Redis pub/sub payload to str (handles both bytes and str)."""
    if isinstance(data, bytes):
        return data.decode("utf-8")
    return data
