"""
Shared async/threading utilities for the telemetry stack.
"""

import asyncio
import ctypes
import logging
import signal
import threading
import time

logger = logging.getLogger(__name__)

_ADJTIMEX_CLOCK_UNSYNCED = 5  # TIME_ERROR in <sys/timex.h>


def clock_is_ntp_synced() -> bool | None:
    """Return whether NTP has set the system clock, or None if the OS can't say.

    A Pi with no internet can't sync, and its clock may have resumed from the last
    time it was on: wrong, but still a plausible recent date.
    """
    try:
        # A zeroed struct timex (modes=0) only reads. It is 208 bytes on 64-bit Linux.
        state = ctypes.CDLL(None).adjtimex(ctypes.create_string_buffer(512))
    except (OSError, AttributeError):
        return None
    if state == -1:
        return None
    return state != _ADJTIMEX_CLOCK_UNSYNCED


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
