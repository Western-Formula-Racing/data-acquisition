from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
import threading
from typing import Optional

import can  # type: ignore[import-not-found]
import websockets

from .models import BridgeState, BridgeStatus, CANFrame
from .parser import ParseError, parse_v2_can_data_envelope

log = logging.getLogger(__name__)


class PecanToKvaserBridge:
    def __init__(
        self,
        ws_url: str,
        channel: int,
        bitrate: int,
        queue_size: int,
        reconnect_min_s: float,
        reconnect_max_s: float,
        dry_run: bool = False,
    ) -> None:
        self._ws_url = ws_url
        self._channel = channel
        self._bitrate = bitrate
        self._queue_size = queue_size
        self._reconnect_min_s = reconnect_min_s
        self._reconnect_max_s = reconnect_max_s
        self._dry_run = dry_run

        self._status = BridgeStatus(
            ws_url=ws_url,
            channel=channel,
            bitrate=bitrate,
        )
        self._status_lock = threading.Lock()

        self._bus: Optional[can.BusABC] = None
        self._running = False
        self._tasks: list[asyncio.Task] = []
        self._queue: asyncio.Queue[CANFrame] = asyncio.Queue(maxsize=queue_size)

    def get_status(self) -> BridgeStatus:
        with self._status_lock:
            current = dataclasses.replace(self._status)
        current.queue_depth = self._queue.qsize()
        return current

    async def start(self) -> None:
        if self._running:
            return

        self._running = True
        if not self._dry_run:
            try:
                self._bus = can.interface.Bus(
                    interface="kvaser",
                    channel=self._channel,
                    bitrate=self._bitrate,
                )
            except Exception as exc:
                self._set_state(BridgeState.ERROR, f"Failed to open Kvaser bus: {exc}")
                self._running = False
                return

        self._set_state(BridgeState.OPEN, "")
        self._tasks = [
            asyncio.create_task(self._ws_ingest_loop()),
            asyncio.create_task(self._can_tx_loop()),
            asyncio.create_task(self._status_log_loop()),
        ]

    async def stop(self) -> None:
        self._running = False
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = []

        if self._bus is not None:
            try:
                self._bus.shutdown()
            except Exception:
                pass
            self._bus = None

        self._set_state(BridgeState.IDLE, "")

    def _set_state(self, state: BridgeState, error_msg: str) -> None:
        with self._status_lock:
            self._status.state = state
            self._status.error_msg = error_msg

    async def _ws_ingest_loop(self) -> None:
        backoff = self._reconnect_min_s

        while self._running:
            try:
                async with websockets.connect(self._ws_url, ping_interval=20, ping_timeout=20, max_size=64 * 1024) as ws:
                    with self._status_lock:
                        self._status.reconnects += 1
                    backoff = self._reconnect_min_s
                    log.info("Connected to Pecan stream: %s", self._ws_url)

                    async for raw in ws:
                        if not self._running:
                            break

                        try:
                            payload = json.loads(raw)
                        except json.JSONDecodeError:
                            with self._status_lock:
                                self._status.dropped_invalid += 1
                            continue

                        try:
                            frames = parse_v2_can_data_envelope(payload)
                        except ParseError as err:
                            with self._status_lock:
                                self._status.dropped_invalid += 1
                            log.debug("Dropped invalid payload (%s): %s", err.code, err.message)
                            continue

                        if not frames:
                            with self._status_lock:
                                self._status.ignored_messages += 1
                            continue

                        with self._status_lock:
                            self._status.frames_rx_ws += len(frames)

                        for frame in frames:
                            try:
                                self._queue.put_nowait(frame)
                            except asyncio.QueueFull:
                                with self._status_lock:
                                    self._status.dropped_queue_full += 1
            except asyncio.CancelledError:
                return
            except Exception as exc:
                if self._running:
                    log.warning("WebSocket stream disconnected: %s", exc)

            if self._running:
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2.0, self._reconnect_max_s)

    async def _can_tx_loop(self) -> None:
        loop = asyncio.get_running_loop()
        while self._running:
            try:
                frame = await self._queue.get()
                if self._dry_run:
                    with self._status_lock:
                        self._status.frames_tx_can += 1
                    continue

                bus = self._bus
                if bus is None:
                    with self._status_lock:
                        self._status.dropped_invalid += 1
                    continue

                msg = can.Message(
                    arbitration_id=frame.can_id,
                    data=bytes(frame.data),
                    is_extended_id=frame.can_id > 0x7FF,
                )
                await loop.run_in_executor(None, bus.send, msg)
                with self._status_lock:
                    self._status.frames_tx_can += 1
            except asyncio.CancelledError:
                return
            except Exception as exc:
                with self._status_lock:
                    self._status.error_msg = str(exc)
                log.error("CAN TX error: %s", exc)

    async def _status_log_loop(self) -> None:
        while self._running:
            try:
                await asyncio.sleep(2.0)
                st = self.get_status()
                log.info(
                    "state=%s rx_ws=%d tx_can=%d dropped_invalid=%d dropped_queue=%d reconnects=%d queue=%d ignored=%d",
                    st.state.name,
                    st.frames_rx_ws,
                    st.frames_tx_can,
                    st.dropped_invalid,
                    st.dropped_queue_full,
                    st.reconnects,
                    st.queue_depth,
                    st.ignored_messages,
                )
            except asyncio.CancelledError:
                return
