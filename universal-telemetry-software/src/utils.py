"""
Shared async/threading utilities for the telemetry stack.
"""

import asyncio
import logging
import signal
import threading
import time

logger = logging.getLogger(__name__)


def start_heartbeat_thread(event) -> threading.Thread:
    """Start a daemon thread that sets *event* every second."""
    def _beat():
        while True:
            event.set()
            time.sleep(1)

    t = threading.Thread(target=_beat, daemon=True)
    t.start()
    return t


async def heartbeat_coro(event, shutdown_event=None) -> None:
    """Coroutine that sets *event* every second.

    Stops when *shutdown_event* is set (pass None to run forever).
    """
    while shutdown_event is None or not shutdown_event.is_set():
        if event is not None:
            event.set()
        await asyncio.sleep(1)


def register_shutdown_signals(
    loop: asyncio.AbstractEventLoop,
    shutdown_event: asyncio.Event,
    label: str = "Service",
) -> None:
    """Register SIGINT/SIGTERM handlers that set *shutdown_event*."""
    def _shutdown():
        logger.info(f"{label} shutting down …")
        shutdown_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _shutdown)
