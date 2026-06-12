"""
Pubsub liveness probe — the producer publishes a heartbeat message on a Redis
pubsub channel every second, and every subscriber also subscribes to that
channel. Liveness is measured on the pubsub connection itself: if no message
of any kind (heartbeat or data) arrives for HEARTBEAT_STALE_S, the connection
is presumed half-dead and the subscriber tears down and re-subscribes.

An out-of-band check (e.g. GET on a heartbeat key) cannot detect this state:
regular commands use a different pool connection that redis-py transparently
reconnects, so the key would look fresh while the pubsub connection is dark.
See docs/superpowers/plans/2026-06-11-stack-resilience.md.
"""
import asyncio
import json
import logging
import time

from .config import HEARTBEAT_STALE_S, REDIS_HEARTBEAT_CHANNEL

logger = logging.getLogger(__name__)

HEARTBEAT_INTERVAL_S = 1.0


async def run_heartbeat_writer(redis_client=None) -> None:
    """Publish a heartbeat message on REDIS_HEARTBEAT_CHANNEL every HEARTBEAT_INTERVAL_S.

    Stops on cancellation. Logs and continues on any other exception so transient
    Redis blips don't take down the writer; if Redis is persistently down, the
    surrounding supervisor (systemd / Docker) is expected to restart the process.
    Skips silently if no Redis client is available (car mode without Redis).
    """
    if redis_client is None:
        return
    start_mono = time.monotonic()
    while True:
        try:
            payload = json.dumps({"uptime_s": time.monotonic() - start_mono,
                                  "wall_ts": time.time()})
            await redis_client.publish(REDIS_HEARTBEAT_CHANNEL, payload)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning(f"Heartbeat publish failed: {e}")
        await asyncio.sleep(HEARTBEAT_INTERVAL_S)


async def pump_pubsub_with_heartbeat(pubsub, on_message, *,
                                     stale_s: float = HEARTBEAT_STALE_S,
                                     should_stop=None,
                                     log=None):
    """Drain a Redis pubsub, returning if the connection goes silent.

    Replaces the naive `async for message in pubsub.listen():` pattern that
    silently goes dark when the TCP connection or subscription state is lost
    after a car power-cycle. The pubsub must be subscribed to
    REDIS_HEARTBEAT_CHANNEL in addition to its data channels; with the producer
    publishing every second, more than `stale_s` of silence means the
    subscription is dead, so the pump returns and the caller's outer loop
    re-subscribes. Heartbeat messages only refresh the liveness clock and are
    not forwarded to `on_message`.

    `on_message` is an `async` callable invoked with the raw pubsub message
    dict for each non-heartbeat message. `should_stop` is an optional callable
    checked every iteration (pass `shutdown_event.is_set` for clean SIGTERM).
    Returns on staleness, pubsub errors, or should_stop; raises on cancellation.
    """
    _log = log or logger
    last_msg_mono = time.monotonic()  # armed at subscribe time
    while True:
        if should_stop is not None and should_stop():
            return
        try:
            msg = await pubsub.get_message(timeout=1.0, ignore_subscribe_messages=True)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            _log.warning(f"pubsub.get_message error, reconnecting: {e}")
            await asyncio.sleep(0.5)
            return  # let the outer while-True re-subscribe

        if msg is not None:
            last_msg_mono = time.monotonic()
            channel = msg.get("channel")
            if isinstance(channel, bytes):
                channel = channel.decode("utf-8", errors="replace")
            if channel == REDIS_HEARTBEAT_CHANNEL:
                continue  # liveness signal only — don't forward
            try:
                await on_message(msg)
            except Exception as e:
                _log.error(f"subscriber handler error: {e}")
        elif time.monotonic() - last_msg_mono > stale_s:
            _log.warning("heartbeat stale, forcing pubsub reconnect")
            return
