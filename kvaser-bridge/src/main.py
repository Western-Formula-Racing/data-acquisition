"""
Kvaser Bridge - entry point.

Starts:
  1. asyncio event loop (bridge tasks) in a background thread
  2. tkinter GUI on the main thread
"""

from __future__ import annotations
import asyncio
import logging
import threading

import config
from bridge import Bridge
from tray import TrayApp

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
)
log = logging.getLogger(__name__)


def _count_kvaser_channels() -> int:
    """Return the number of Kvaser channels detected, or 1 as a fallback."""
    try:
        from canlib import canlib
        return canlib.getNumberOfChannels()
    except Exception:
        log.warning('Could not enumerate Kvaser channels (canlib not available?). Defaulting to 1.')
        return 1


def _run_asyncio_loop(loop: asyncio.AbstractEventLoop) -> None:
    asyncio.set_event_loop(loop)
    loop.run_forever()


def main() -> None:
    cfg = config.load()
    channel = cfg.get('channel', config.DEFAULT_CHANNEL)
    bitrate = cfg.get('bitrate', config.DEFAULT_BITRATE)
    ws_port = cfg.get('ws_port', config.DEFAULT_WS_PORT)

    num_channels = _count_kvaser_channels()
    channel = min(channel, num_channels - 1)

    loop = asyncio.new_event_loop()

    bridge = Bridge(channel=channel, bitrate=bitrate, ws_port=ws_port)

    def on_quit():
        config.save({
            'channel': bridge.get_status().channel,
            'bitrate': bridge.get_status().bitrate,
            'ws_port': bridge.get_status().ws_port,
        })
        future = asyncio.run_coroutine_threadsafe(bridge.stop(), loop)
        try:
            future.result(timeout=3)
        except Exception:
            pass
        loop.call_soon_threadsafe(loop.stop)

    tray = TrayApp(
        bridge=bridge,
        loop=loop,
        num_channels=num_channels,
        initial_channel=channel,
        initial_bitrate=bitrate,
        initial_ws_port=ws_port,
        on_quit=on_quit,
    )

    asyncio_thread = threading.Thread(
        target=_run_asyncio_loop,
        args=(loop,),
        daemon=True,
        name='asyncio-bridge',
    )
    asyncio_thread.start()

    log.info('Kvaser Bridge starting')
    tray.run()
    log.info('Kvaser Bridge exited')


if __name__ == '__main__':
    main()
