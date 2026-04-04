from __future__ import annotations

import argparse
import asyncio
import logging
import signal
from dataclasses import replace

from . import config
from .bridge import PecanToKvaserBridge


def _count_kvaser_channels() -> int:
    try:
        from canlib import canlib  # type: ignore[import-not-found]

        return int(canlib.getNumberOfChannels())
    except Exception:
        return 0


def _parse_args() -> argparse.Namespace:
    cfg = config.load()

    parser = argparse.ArgumentParser(description="Pecan stream to Kvaser bridge (v2-only)")
    parser.add_argument("--ws-url", default=cfg.ws_url, help="Pecan/UTS WebSocket URL (v2 protocol)")
    parser.add_argument("--channel", type=int, default=cfg.channel, help="Kvaser hardware channel index")
    parser.add_argument("--bitrate", type=int, default=cfg.bitrate, help="CAN bitrate (default 500000)")
    parser.add_argument("--queue-size", type=int, default=cfg.queue_size, help="Inbound queue depth")
    parser.add_argument("--reconnect-min", type=float, default=cfg.reconnect_min_s, help="Reconnect backoff min seconds")
    parser.add_argument("--reconnect-max", type=float, default=cfg.reconnect_max_s, help="Reconnect backoff max seconds")
    parser.add_argument("--dry-run", action="store_true", help="Parse and queue frames without opening Kvaser hardware")
    parser.add_argument("--log-level", default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    parser.add_argument("--no-save-config", action="store_true", help="Do not persist launch config")
    return parser.parse_args()


async def _run(args: argparse.Namespace) -> int:
    channels = _count_kvaser_channels()
    if not args.dry_run:
        if channels <= 0:
            print("No Kvaser channels detected. Install CANlib drivers or use --dry-run.")
            return 2
        if args.channel < 0 or args.channel >= channels:
            print(f"Invalid channel {args.channel}; detected channels: 0..{channels - 1}")
            return 2

    if args.reconnect_min <= 0 or args.reconnect_max <= 0 or args.reconnect_min > args.reconnect_max:
        print("Invalid reconnect settings: require 0 < reconnect-min <= reconnect-max")
        return 2

    bridge = PecanToKvaserBridge(
        ws_url=args.ws_url,
        channel=args.channel,
        bitrate=args.bitrate,
        queue_size=args.queue_size,
        reconnect_min_s=args.reconnect_min,
        reconnect_max_s=args.reconnect_max,
        dry_run=args.dry_run,
    )

    stop_event = asyncio.Event()

    def _request_stop() -> None:
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _request_stop)
        except NotImplementedError:
            pass

    await bridge.start()
    if bridge.get_status().state.name == "ERROR":
        print(f"Bridge start failed: {bridge.get_status().error_msg}")
        return 1

    await stop_event.wait()
    await bridge.stop()

    if not args.no_save_config:
        cfg = config.BridgeConfig(
            ws_url=args.ws_url,
            channel=args.channel,
            bitrate=args.bitrate,
            queue_size=args.queue_size,
            reconnect_min_s=args.reconnect_min,
            reconnect_max_s=args.reconnect_max,
        )
        config.save(cfg)

    return 0


def main() -> None:
    args = _parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    raise SystemExit(asyncio.run(_run(args)))


if __name__ == "__main__":
    main()
