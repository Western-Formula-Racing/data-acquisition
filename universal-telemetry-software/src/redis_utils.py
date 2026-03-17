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


def get_sync_client(url: str):
    """Return a connected synchronous Redis client, or None on failure."""
    try:
        client = redis.from_url(url)
        client.ping()
        logger.info("Connected to Redis")
        return client
    except Exception as e:
        logger.warning(
            f"Could not connect to Redis: {e}. "
            "Data will not be published to Redis."
        )
        return None


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
