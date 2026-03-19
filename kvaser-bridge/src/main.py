"""
Kvaser Bridge - entry point.

Starts:
  1. asyncio event loop (bridge tasks) in a background thread
  2. tkinter GUI on the main thread (or TUI, or headless)
"""

from __future__ import annotations
import argparse
import asyncio
import logging
import signal
import threading
import time

import config
from bridge import Bridge, BridgeState
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


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Kvaser Bridge launcher')
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--tui', action='store_true', help='Run in terminal UI mode')
    modes.add_argument('--headless', action='store_true', help='Run with no UI')
    parser.add_argument(
        '--no-tls', action='store_true',
        help='Serve plain ws:// instead of wss:// (no certificate required). '
             'Useful for Pecna dashboard on local network — defaults port to 9080.',
    )
    return parser.parse_args()


def _run_headless(bridge: Bridge, loop: asyncio.AbstractEventLoop, shutdown: threading.Event) -> None:
    """Run bridge without UI until interrupted."""
    future = asyncio.run_coroutine_threadsafe(bridge.start(), loop)
    future.result(timeout=5)

    startup_status = bridge.get_status()
    if startup_status.state == BridgeState.ERROR:
        log.error('Bridge failed to start: %s', startup_status.error_msg or 'unknown error')
        return

    log.info('Headless mode running. Press Ctrl+C to stop.')
    last_state = None
    last_frames = -1
    last_clients = -1
    last_log = 0.0

    while not shutdown.is_set():
        now = time.monotonic()
        status = bridge.get_status()
        should_log = (
            status.state != last_state
            or status.clients != last_clients
            or status.frames_rx != last_frames
            or now - last_log >= 5.0
        )

        if should_log:
            log.info(
                'state=%s frames_rx=%d clients=%d error=%s',
                status.state.name,
                status.frames_rx,
                status.clients,
                status.error_msg or '-',
            )
            last_state = status.state
            last_clients = status.clients
            last_frames = status.frames_rx
            last_log = now

        if status.state == BridgeState.ERROR:
            log.error('Bridge entered error state: %s', status.error_msg or 'unknown error')
            break

        shutdown.wait(0.25)


def main() -> None:
    args = _parse_args()
    cfg = config.load()
    channel = cfg.get('channel', config.DEFAULT_CHANNEL)
    bitrate = cfg.get('bitrate', config.DEFAULT_BITRATE)
    ws_port = cfg.get('ws_port', config.DEFAULT_WS_PORT)
    can_interface = cfg.get('can_interface', config.DEFAULT_CAN_INTERFACE)

    # --no-tls: serve plain ws:// (no certificate required)
    tls = not args.no_tls

    num_channels = _count_kvaser_channels()
    channel = min(channel, num_channels - 1)

    loop = asyncio.new_event_loop()

    bridge = Bridge(
        channel=channel,
        bitrate=bitrate,
        ws_port=ws_port,
        can_interface=can_interface,
        tls=tls,
    )

    shutdown = threading.Event()

    def on_quit():
        if shutdown.is_set():
            return
        shutdown.set()
        final = bridge.get_status()
        config.save({
            'can_interface': final.can_interface,
            'channel': final.channel,
            'bitrate': final.bitrate,
            'ws_port': final.ws_port,
        })
        future = asyncio.run_coroutine_threadsafe(bridge.stop(), loop)
        try:
            future.result(timeout=3)
        except Exception:
            pass
        loop.call_soon_threadsafe(loop.stop)

    def on_signal(sig, frame):
        log.info('Received signal %s, shutting down...', sig)
        on_quit()

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)

    app = None
    runtime_mode = 'headless' if args.headless else ('tui' if args.tui else 'gui')
    if args.tui:
        try:
            from tui import TuiApp
            app = TuiApp(
                bridge=bridge,
                loop=loop,
                num_channels=num_channels,
                initial_channel=channel,
                initial_bitrate=bitrate,
                initial_ws_port=ws_port,
                on_quit=on_quit,
                can_interface=can_interface,
            )
        except (ModuleNotFoundError, RuntimeError) as e:
            log.error('TUI dependencies missing: %s', e)
            log.error('Install requirements and retry: pip install -r requirements.txt')
            raise SystemExit(2)
    elif not args.headless:
        try:
            from tray import TrayApp

            app = TrayApp(
                bridge=bridge,
                loop=loop,
                num_channels=num_channels,
                initial_channel=channel,
                initial_bitrate=bitrate,
                initial_ws_port=ws_port,
                on_quit=on_quit,
                can_interface=can_interface,
            )
        except ModuleNotFoundError as e:
            if e.name not in {'tkinter', '_tkinter'}:
                raise

            log.warning('Tk GUI unavailable (%s). Falling back to TUI mode.', e)
            try:
                from tui import TuiApp

                app = TuiApp(
                    bridge=bridge,
                    loop=loop,
                    num_channels=num_channels,
                    initial_channel=channel,
                    initial_bitrate=bitrate,
                    initial_ws_port=ws_port,
                    on_quit=on_quit,
                    can_interface=can_interface,
                )
                runtime_mode = 'tui'
            except (ModuleNotFoundError, RuntimeError) as te:
                log.error('TUI dependencies missing: %s', te)
                log.error('Install requirements and retry: pip install -r requirements.txt')
                log.error('Or run explicitly with --headless')
                raise SystemExit(2)

    asyncio_thread = threading.Thread(
        target=_run_asyncio_loop,
        args=(loop,),
        daemon=True,
        name='asyncio-bridge',
    )
    asyncio_thread.start()

    log.info('Kvaser Bridge starting (mode=%s)', runtime_mode)

    if args.headless:
        _run_headless(bridge, loop, shutdown)
    elif app:
        app.run()

    log.info('Kvaser Bridge exited')


if __name__ == '__main__':
    main()
