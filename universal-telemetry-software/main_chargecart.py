import asyncio
import json
import logging
import os
import random
import signal
import struct
import time

import can

from src.websocket_bridge import run_websocket_bridge
from src.websocket_bridge_tx import run_tx_bridge

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger("ChargecartMain")

BATCH_SIZE = int(os.getenv("CHARGECART_BATCH_SIZE", "20"))
BATCH_TIMEOUT = float(os.getenv("CHARGECART_BATCH_TIMEOUT", "0.05"))
QUEUE_MAXSIZE = int(os.getenv("CHARGECART_QUEUE_MAXSIZE", "2000"))
ECU_TIMESTAMP_ID = 1999


def _now_epoch_ms() -> int:
    return int(time.time() * 1000)


def _heartbeat_frame() -> dict:
    epoch_ms = _now_epoch_ms()
    data = list(struct.pack("<q", epoch_ms))
    return {"time": epoch_ms, "canId": ECU_TIMESTAMP_ID, "data": data}


async def _publish_batch(queue: asyncio.Queue, batch: list[dict]) -> None:
    if not batch:
        return
    try:
        queue.put_nowait(json.dumps(batch))
    except asyncio.QueueFull:
        logger.warning("Chargecart RX queue full; dropping %d CAN frames", len(batch))


async def can0_reader(queue: asyncio.Queue, shutdown_event: asyncio.Event) -> None:
    """Read can0 and feed the RX websocket directly.

    This intentionally skips the normal car/base UDP, TCP resend, Redis,
    diagnostics, audio, video, and Timescale paths. Chargecart is a local live
    BMS display/control appliance, not a storage backend.
    """
    simulate = os.getenv("SIMULATE", "false").lower() == "true"
    batch: list[dict] = []
    last_flush = time.monotonic()
    last_heartbeat = 0.0

    bus = None
    if simulate:
        logger.warning("Chargecart SIMULATE=true: generating synthetic CAN frames")
    else:
        bus = can.interface.Bus(channel=os.getenv("CAN_CHANNEL", "can0"), bustype="socketcan")
        logger.info("Chargecart CAN reader started on %s", os.getenv("CAN_CHANNEL", "can0"))

    loop = asyncio.get_running_loop()

    while not shutdown_event.is_set():
        now = time.monotonic()

        if now - last_heartbeat >= 1.0:
            batch.append(_heartbeat_frame())
            last_heartbeat = now

        if simulate:
            await asyncio.sleep(0.01)
            frame = {
                "time": _now_epoch_ms(),
                "canId": random.choice([1001, 1002, 1003, 1004, 1005, 1006, 1011, 1016, 1021, 1026, 1031, 1036, 1041, 1046, 1051, 1056, 1057]),
                "data": [random.randint(0, 255) for _ in range(8)],
            }
            batch.append(frame)
        else:
            msg = await loop.run_in_executor(None, lambda: bus.recv(BATCH_TIMEOUT))
            if msg and not msg.is_error_frame and not msg.is_remote_frame:
                batch.append({
                    "time": _now_epoch_ms(),
                    "canId": msg.arbitration_id,
                    "data": list(msg.data),
                })

        if batch and (len(batch) >= BATCH_SIZE or time.monotonic() - last_flush >= BATCH_TIMEOUT):
            await _publish_batch(queue, batch)
            batch = []
            last_flush = time.monotonic()


async def run_chargecart() -> None:
    shutdown_event = asyncio.Event()
    queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAXSIZE)

    loop = asyncio.get_running_loop()

    def stop() -> None:
        logger.info("Chargecart runtime shutting down")
        shutdown_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop)

    logger.info("Starting chargecart runtime: can0 RX, local RX websocket, local-only balance TX")

    await asyncio.gather(
        can0_reader(queue, shutdown_event),
        run_websocket_bridge(
            direct_queue=queue,
            external_shutdown_event=shutdown_event,
            register_signals=False,
        ),
        run_tx_bridge(
            external_shutdown_event=shutdown_event,
            register_signals=False,
        ),
    )


if __name__ == "__main__":
    asyncio.run(run_chargecart())
