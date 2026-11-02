"""
Durable on-board CAN recorder: the car's only permanent record of the bus.

Runs as its own systemd service (deploy/can-recorder.service) rather than inside
the telemetry stack, so a telemetry crash, restart or stalled event loop cannot
interrupt recording. It opens its own CAN_RAW socket and uses only the standard
library, so it starts under the system Python without `uv run`.

Two threads keep slow storage away from the bus:

    can0 -> reader thread -> in-memory queue -> writer thread -> fdatasync

The reader never touches the disk, so a stalled SD card only grows the queue.
The writer commits a block every --commit-ms. After a power cut, what is lost is
whatever had not yet been committed, plus anything the storage acknowledged
falsely (test that with deploy/CAN_RECORDER.md, "Power-cut test").

    python -m src.can_recorder --iface can0 --dir /var/lib/can-recorder
"""

from __future__ import annotations

import argparse
import collections
import json
import logging
import os
import re
import signal
import socket
import struct
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from src.canlog import RECORD, encode_block, encode_file_header

logger = logging.getLogger("can_recorder")

# From asm-generic/socket.h; not exported by Python's socket module.
SO_TIMESTAMPNS = 35
SO_RXQ_OVFL = 40

_CAN_FRAME_SIZE = 16
_TIMESPEC = struct.Struct("@ll")
_U32 = struct.Struct("@I")
_ANCILLARY_SPACE = socket.CMSG_SPACE(_TIMESPEC.size) + socket.CMSG_SPACE(_U32.size)

# 4 MiB holds thousands of frames, far longer than any scheduling stall.
_SOCKET_RCVBUF = 4 * 1024 * 1024
_SOCKET_POLL_S = 0.25
_SOCKET_RETRY_S = 0.2
_WRITE_RETRY_S = 1.0
_STOP_WRITE_ATTEMPTS = 3
_HOUSEKEEPING_S = 1.0
_COMMIT_WARN_S = 0.5
_ERROR_LOG_INTERVAL_S = 30.0

# Caps one block so that a torn write after a long stall costs little.
MAX_FRAMES_PER_BLOCK = 2700
# About 7 minutes at 100% load on a 500 kbps bus, about 150 MB of RAM.
DEFAULT_MAX_QUEUED_FRAMES = 2_000_000

_RUN_RE = re.compile(r"^run-(\d+)$")


@dataclass
class Config:
    iface: str = "can0"
    directory: str = "/var/lib/can-recorder"
    commit_ms: int = 100
    segment_seconds: int = 60
    segment_bytes: int = 32 * 1024 * 1024
    status_file: str | None = None
    ack_addr: tuple[str, int] | None = None
    max_queued_frames: int = DEFAULT_MAX_QUEUED_FRAMES


def open_can_socket(iface: str) -> socket.socket:
    sock = socket.socket(socket.PF_CAN, socket.SOCK_RAW, socket.CAN_RAW)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, _SOCKET_RCVBUF)
        sock.setsockopt(socket.SOL_SOCKET, SO_TIMESTAMPNS, 1)
        sock.setsockopt(socket.SOL_SOCKET, SO_RXQ_OVFL, 1)
        # Record error frames too: they timestamp bus-off and controller overflow.
        sock.setsockopt(socket.SOL_CAN_RAW, socket.CAN_RAW_ERR_FILTER, struct.pack("@I", socket.CAN_ERR_MASK))
        sock.settimeout(_SOCKET_POLL_S)
        sock.bind((iface,))
    except OSError:
        sock.close()
        raise
    return sock


def _fsync_dir(path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]


def _boot_id() -> str:
    try:
        return Path("/proc/sys/kernel/random/boot_id").read_text().strip().replace("-", "")
    except OSError:
        return "00" * 16


def allocate_run_id(root) -> int:
    """Next run number, from what is on disk: the wall clock may be stale at boot."""
    highest = 0
    for name in os.listdir(root):
        match = _RUN_RE.match(name)
        if match:
            highest = max(highest, int(match.group(1)))
    return highest + 1


def sd_notify(message: str) -> None:
    address = os.environ.get("NOTIFY_SOCKET")
    if not address:
        return
    if address.startswith("@"):
        address = "\0" + address[1:]
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
            sock.sendto(message.encode(), address)
    except OSError as e:
        logger.debug("sd_notify failed: %s", e)


class SegmentWriter:
    """Durably appends blocks to one run's segment files. Raises OSError on failure."""

    def __init__(self, config: Config):
        self._config = config
        self._boot_id = _boot_id()
        self.run_id = 0
        self.run_dir: Path | None = None
        self.segment = 0
        self._fd: int | None = None
        self._opened_at = 0.0
        self._bytes = 0

    def _open_run(self) -> None:
        root = self._config.directory
        os.makedirs(root, exist_ok=True)
        run_id = allocate_run_id(root)
        run_dir = Path(root) / f"run-{run_id:06d}"
        os.mkdir(run_dir)
        _fsync_dir(root)
        self.run_id, self.run_dir = run_id, run_dir

    def _open_segment(self) -> None:
        if self.run_dir is None:
            self._open_run()
        self.segment += 1
        path = self.run_dir / f"seg-{self.segment:06d}.wcan"
        # A new file for every segment and retry: a file that may hold a torn
        # write or a failed sync is never reopened.
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND | os.O_CLOEXEC, 0o644)
        try:
            _write_all(fd, encode_file_header(
                self.run_id, self.segment, self._config.iface, self._boot_id,
                time.time_ns(), time.monotonic_ns(),
            ))
            os.fdatasync(fd)
            # Without this, a power cut can lose the file's directory entry.
            _fsync_dir(self.run_dir)
        except OSError:
            os.close(fd)
            raise
        self._fd = fd
        self._opened_at = time.monotonic()
        self._bytes = 0
        logger.info("Recording to %s", path)

    def _should_rotate(self) -> bool:
        return (
            self._bytes >= self._config.segment_bytes
            or time.monotonic() - self._opened_at >= self._config.segment_seconds
        )

    def commit(self, block: bytes) -> None:
        if self._fd is not None and self._should_rotate():
            self.close_segment()
        if self._fd is None:
            self._open_segment()
        _write_all(self._fd, block)
        os.fdatasync(self._fd)
        self._bytes += len(block)

    def close_segment(self) -> None:
        if self._fd is not None:
            fd, self._fd = self._fd, None
            try:
                os.close(fd)
            except OSError as e:
                logger.warning("Closing segment failed: %s", e)


class Recorder:
    def __init__(self, config: Config):
        self.config = config
        self.writer = SegmentWriter(config)
        self._queue: collections.deque[bytes] = collections.deque()
        self._stop = threading.Event()
        self._reader_thread: threading.Thread | None = None
        self._writer_thread: threading.Thread | None = None
        self.committed_frames = 0
        self.socket_drops = 0
        self.queue_drops = 0
        self._last_frame_mono = 0.0
        self._last_commit_mono = 0.0
        self._last_commit_ms = 0.0
        self._max_commit_ms = 0.0
        self._write_error: str | None = None
        self._last_error_log = 0.0
        self._last_housekeeping = 0.0
        self._retry_delay = _WRITE_RETRY_S
        self._ack_sock = None
        self._overrun_path = Path(f"/sys/class/net/{config.iface}/statistics/rx_over_errors")
        if config.ack_addr:
            self._ack_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self._ack_sock.setblocking(False)
        self._recorder_id = os.urandom(4).hex()

    def start(self) -> None:
        self._reader_thread = threading.Thread(target=self._reader_loop, name="can-reader", daemon=True)
        self._writer_thread = threading.Thread(target=self._writer_loop, name="can-writer", daemon=True)
        self._reader_thread.start()
        self._writer_thread.start()

    def stop(self) -> None:
        self._stop.set()

    def threads_alive(self) -> bool:
        return self._reader_thread.is_alive() and self._writer_thread.is_alive()

    def join(self, timeout: float | None = None) -> None:
        self._writer_thread.join(timeout)

    def _log_error(self, message: str, *args) -> None:
        """Log at most every 30 s, so a long fault cannot wear the card with log writes."""
        now = time.monotonic()
        if now - self._last_error_log >= _ERROR_LOG_INTERVAL_S:
            self._last_error_log = now
            logger.error(message, *args)

    def _reader_loop(self) -> None:
        drops_from_closed_sockets = 0
        queue = self._queue
        record = RECORD.pack
        limit = self.config.max_queued_frames
        while not self._stop.is_set():
            try:
                sock = open_can_socket(self.config.iface)
            except OSError as e:
                self._log_error("Cannot open %s, retrying: %s", self.config.iface, e)
                self._stop.wait(_SOCKET_RETRY_S)
                continue
            logger.info("Listening on %s", self.config.iface)
            try:
                while not self._stop.is_set():
                    try:
                        data, ancillary, _, _ = sock.recvmsg(_CAN_FRAME_SIZE, _ANCILLARY_SPACE)
                    except TimeoutError:
                        continue
                    ts_ns = 0
                    for level, kind, value in ancillary:
                        if level == socket.SOL_SOCKET:
                            if kind == SO_TIMESTAMPNS:
                                seconds, nanoseconds = _TIMESPEC.unpack_from(value)
                                ts_ns = seconds * 1_000_000_000 + nanoseconds
                            elif kind == SO_RXQ_OVFL:
                                self.socket_drops = drops_from_closed_sockets + _U32.unpack_from(value)[0]
                    if len(data) != _CAN_FRAME_SIZE:
                        continue
                    if len(queue) >= limit:
                        self.queue_drops += 1
                        continue
                    queue.append(record(ts_ns or time.time_ns(), data))
                    self._last_frame_mono = time.monotonic()
            except OSError as e:
                # ENETDOWN and friends: the interface bounced, so reopen and carry on.
                self._log_error("Read from %s failed, reopening: %s", self.config.iface, e)
                self._stop.wait(_SOCKET_RETRY_S)
            finally:
                sock.close()
                # SO_RXQ_OVFL counts per socket, so keep the total across reopens.
                drops_from_closed_sockets = self.socket_drops

    def _drain(self) -> list[bytes]:
        queue = self._queue
        return [queue.popleft() for _ in range(min(len(queue), MAX_FRAMES_PER_BLOCK))]

    def _read_hw_overruns(self) -> int:
        try:
            return int(self._overrun_path.read_text())
        except (OSError, ValueError):
            return 0

    def _reader_alive(self) -> bool:
        return self._reader_thread is not None and self._reader_thread.is_alive()

    def _writer_loop(self) -> None:
        interval = self.config.commit_ms / 1000
        pending: bytes | None = None
        pending_end = 0
        failed_stop_attempts = 0
        while True:
            started = time.monotonic()
            if pending is None:
                records = self._drain()
                if records:
                    pending = encode_block(
                        records, self.committed_frames, time.time_ns(), time.monotonic_ns(),
                        self.socket_drops, self.queue_drops, self._read_hw_overruns(),
                    )
                    pending_end = self.committed_frames + len(records)
            if pending is not None:
                try:
                    self.writer.commit(pending)
                except OSError as e:
                    # The kernel may discard dirty pages after a failed sync, so
                    # retrying the same file could report success falsely. Write
                    # the block again to a new segment; readers ignore the duplicate.
                    self._write_error = str(e)
                    self._log_error("Commit failed, retrying in a new segment: %s", e)
                    self.writer.close_segment()
                    self._housekeeping()
                    if not self._reader_alive():
                        failed_stop_attempts += 1
                        if failed_stop_attempts >= _STOP_WRITE_ATTEMPTS:
                            unwritten = len(self._queue) + pending_end - self.committed_frames
                            logger.error("Giving up with %d frames unwritten", unwritten)
                            break
                    time.sleep(self._retry_delay)
                    continue
                self._after_commit(started, pending_end)
                pending = None
            self._housekeeping()
            if not self._reader_alive() and not self._queue:
                break
            if len(self._queue) < MAX_FRAMES_PER_BLOCK:
                time.sleep(max(0.0, interval - (time.monotonic() - started)))
        self.writer.close_segment()
        self._housekeeping(force=True)

    def _after_commit(self, started: float, end_frame: int) -> None:
        now = time.monotonic()
        self.committed_frames = end_frame
        self._write_error = None
        self._last_commit_mono = now
        self._last_commit_ms = (now - started) * 1000
        self._max_commit_ms = max(self._max_commit_ms, self._last_commit_ms)
        if now - started > _COMMIT_WARN_S:
            logger.warning("Slow commit: %.0f ms", self._last_commit_ms)
        if self._ack_sock is not None:
            message = f"run={self.writer.run_id} frames={end_frame} recorder={self._recorder_id}\n".encode()
            try:
                self._ack_sock.sendto(message, self.config.ack_addr)
            except OSError:
                pass

    def _housekeeping(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_housekeeping < _HOUSEKEEPING_S:
            return
        self._last_housekeeping = now
        sd_notify("WATCHDOG=1")
        if self.config.status_file:
            try:
                self._write_status(now)
            except OSError as e:
                logger.debug("Status file not written: %s", e)

    def _write_status(self, now: float) -> None:
        status = {
            "ts": time.time(),
            "state": "error" if self._write_error else ("recording" if self._last_commit_mono else "waiting"),
            "write_error": self._write_error,
            "iface": self.config.iface,
            "run": self.writer.run_id,
            "segment": self.writer.segment,
            "frames_committed": self.committed_frames,
            "frames_queued": len(self._queue),
            "last_frame_age_s": round(now - self._last_frame_mono, 3) if self._last_frame_mono else None,
            "last_commit_age_s": round(now - self._last_commit_mono, 3) if self._last_commit_mono else None,
            "commit_ms_last": round(self._last_commit_ms, 2),
            "commit_ms_max": round(self._max_commit_ms, 2),
            "socket_drops": self.socket_drops,
            "queue_drops": self.queue_drops,
            "hw_overruns_since_boot": self._read_hw_overruns(),
        }
        try:
            stat = os.statvfs(self.config.directory)
            status["free_bytes"] = stat.f_bavail * stat.f_frsize
        except OSError:
            status["free_bytes"] = None
        path = self.config.status_file
        tmp = f"{path}.tmp"
        with open(tmp, "w") as f:
            json.dump(status, f)
        os.replace(tmp, path)


def _parse_addr(value: str) -> tuple[str, int]:
    host, _, port = value.rpartition(":")
    if not host or not port.isdigit():
        raise argparse.ArgumentTypeError("expected HOST:PORT")
    return host, int(port)


def main(argv=None) -> int:
    defaults = Config()
    parser = argparse.ArgumentParser(description="Durable on-board CAN recorder")
    parser.add_argument("--iface", default=defaults.iface)
    parser.add_argument("--dir", dest="directory", default=defaults.directory)
    parser.add_argument("--commit-ms", type=int, default=defaults.commit_ms,
                        help="upper bound on frames at risk from a power cut")
    parser.add_argument("--segment-seconds", type=int, default=defaults.segment_seconds)
    parser.add_argument("--status-file", help="JSON status, rewritten every second (use tmpfs)")
    parser.add_argument("--ack-udp", dest="ack_addr", type=_parse_addr, metavar="HOST:PORT",
                        help="report each durable commit over UDP (power-cut test)")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    recorder = Recorder(Config(
        iface=args.iface,
        directory=args.directory,
        commit_ms=args.commit_ms,
        segment_seconds=args.segment_seconds,
        status_file=args.status_file,
        ack_addr=args.ack_addr,
    ))

    requested = threading.Event()

    def _on_signal(signum, _frame):
        logger.info("Received signal %d, committing and stopping", signum)
        requested.set()
        recorder.stop()

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    recorder.start()
    sd_notify("READY=1")
    logger.info("CAN recorder running: iface=%s dir=%s commit=%d ms",
                args.iface, args.directory, args.commit_ms)

    while recorder.threads_alive():
        time.sleep(0.2)
    recorder.stop()
    recorder.join(timeout=5)
    if requested.is_set():
        return 0
    logger.error("A recorder thread stopped unexpectedly; exiting so systemd restarts us")
    return 1


if __name__ == "__main__":
    sys.exit(main())
