"""Crash-tolerance tests for the on-board CAN recorder.

The unit tests need no hardware. The end-to-end tests run a real recorder process
against a virtual CAN interface and are skipped when there isn't one:

    sudo modprobe vcan && sudo ip link add vcan0 type vcan && sudo ip link set up vcan0

None of this replaces the power-cut test in deploy/CAN_RECORDER.md. SIGKILL leaves
the page cache intact, so it proves the process side only, not the storage.
"""

import errno
import json
import os
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from src import can_recorder, canlog
from src.can_recorder import Config, Recorder, SegmentWriter
from src.canlog import (
    CAN_EFF_FLAG,
    CAN_ERR_FLAG,
    CAN_RTR_FLAG,
    ECU_TIMESTAMP_ID,
    RECORD,
    SECTOR,
    can_frame,
    encode_block,
    iter_run,
    new_report,
    scan_segment,
)

UTS_ROOT = Path(__file__).resolve().parents[1]
TEST_IFACE = os.getenv("CAN_RECORDER_TEST_IFACE", "vcan0")
BASE_NS = 1_793_000_000_000_000_000
FRAME_NS = 1_000_000


def _records(count, start=0, can_id=0x100):
    """RECORD-packed frames whose payload carries their own index."""
    return [
        RECORD.pack(BASE_NS + i * FRAME_NS, can_frame(can_id, struct.pack("<Q", i)))
        for i in range(start, start + count)
    ]


def _write_run(root, blocks=5, frames_per_block=50) -> Path:
    writer = SegmentWriter(Config(directory=str(root)))
    for b in range(blocks):
        first = b * frames_per_block
        writer.commit(encode_block(_records(frames_per_block, first), first, BASE_NS + first, 0))
    writer.close_segment()
    return writer.run_dir


def _counters(run_dir):
    return [
        struct.unpack("<Q", frame.data)[0]
        for block in iter_run(run_dir)
        for frame in block.frames()
    ]


def _single_segment(run_dir) -> Path:
    segments = sorted(run_dir.glob("seg-*.wcan"))
    assert len(segments) == 1
    return segments[0]


def _report(run_dir):
    report = new_report(run_dir)
    for _ in iter_run(run_dir, report):
        pass
    return report


def test_round_trip_preserves_everything_the_telemetry_format_drops(tmp_path):
    frames = [
        (1, 0x123, b"\x01\x02\x03"),  # short DLC
        (2, CAN_EFF_FLAG | 0x18FF50E5, b"\xAA" * 8),  # 29-bit ID
        (3, 0x123, b""),  # zero-length
        (4, CAN_RTR_FLAG | 0x123, b""),
        (5, CAN_ERR_FLAG | 0x004, b"\0" * 8),  # controller error frame
    ]
    writer = SegmentWriter(Config(directory=str(tmp_path)))
    writer.commit(encode_block([RECORD.pack(ts, can_frame(i, d)) for ts, i, d in frames], 0, 1, 2))
    writer.close_segment()

    got = [f for block in iter_run(writer.run_dir) for f in block.frames()]

    assert [(f.ts_ns, f.can_id, f.data[:f.dlc]) for f in got] == frames
    assert [f.dlc for f in got] == [3, 8, 0, 0, 8]


def test_every_commit_ends_on_a_sector_and_never_rewrites_earlier_bytes(tmp_path):
    """Committed sectors are never touched again, so a torn write cannot reach them."""
    writer = SegmentWriter(Config(directory=str(tmp_path)))
    previous = b""
    for i in range(4):
        writer.commit(encode_block(_records(7 + i * 300, i), i, 0, 0))
        current = _single_segment(writer.run_dir).read_bytes()
        assert len(current) % SECTOR == 0
        assert current.startswith(previous)
        previous = current
    writer.close_segment()


def test_truncation_at_any_offset_keeps_every_complete_block(tmp_path):
    """Simulates a power cut landing anywhere inside the last two blocks."""
    run_dir = _write_run(tmp_path / "src", blocks=4, frames_per_block=200)
    segment = _single_segment(run_dir)
    original = segment.read_bytes()
    block_size = (len(original) - SECTOR) // 4
    used = canlog.BLOCK_HEAD.size + 200 * RECORD.size  # the rest of a block is padding
    for cut in range(len(original) - 2 * block_size, len(original), 97):
        segment.write_bytes(original[:cut])
        complete_blocks = sum(SECTOR + i * block_size + used <= cut for i in range(4))
        assert _counters(run_dir) == list(range(complete_blocks * 200)), f"cut at {cut}"


def test_garbage_tail_is_reported_and_earlier_blocks_survive(tmp_path):
    run_dir = _write_run(tmp_path, blocks=3)
    segment = _single_segment(run_dir)
    with open(segment, "ab") as f:
        f.write(os.urandom(SECTOR) + b"\0" * SECTOR + os.urandom(100))

    report = _report(run_dir)

    assert report.frames == 150
    assert report.damaged_tail == 2
    assert report.damaged_interior == 0
    assert report.problems == []


def test_bit_flip_loses_only_that_block_and_counts_the_loss_exactly(tmp_path):
    frames_per_block = 50
    run_dir = _write_run(tmp_path, blocks=5, frames_per_block=frames_per_block)
    segment = _single_segment(run_dir)
    data = bytearray(segment.read_bytes())
    block_size = (len(data) - SECTOR) // 5
    data[SECTOR + 2 * block_size + 200] ^= 0x01  # inside the third block
    segment.write_bytes(data)

    report = _report(run_dir)

    assert report.lost_frames == frames_per_block
    assert report.frames == 4 * frames_per_block
    assert report.damaged_interior == 1
    assert _counters(run_dir) == [*range(100), *range(150, 250)]
    assert any("lost" in p for p in report.problems)


def test_corrupt_segment_header_does_not_cost_the_blocks(tmp_path):
    run_dir = _write_run(tmp_path, blocks=3)
    segment = _single_segment(run_dir)
    data = bytearray(segment.read_bytes())
    data[20] ^= 0xFF
    segment.write_bytes(data)

    assert scan_segment(segment).header is None
    assert _report(run_dir).bad_headers == 1
    assert _counters(run_dir) == list(range(150))


def test_segment_header_round_trip(tmp_path):
    run_dir = _write_run(tmp_path, blocks=1)
    header = scan_segment(_single_segment(run_dir)).header
    assert (header.run_id, header.segment, header.iface) == (1, 1, "can0")


def test_each_run_gets_a_new_directory_and_never_reopens_old_files(tmp_path):
    first = _write_run(tmp_path, blocks=1)
    before = _single_segment(first).read_bytes()
    second = _write_run(tmp_path, blocks=1)

    assert (first.name, second.name) == ("run-000001", "run-000002")
    assert _single_segment(first).read_bytes() == before
    assert [p.name for p in canlog.list_runs(tmp_path)] == ["run-000001", "run-000002"]


def test_segments_rotate_without_losing_frames(tmp_path):
    writer = SegmentWriter(Config(directory=str(tmp_path), segment_bytes=3 * SECTOR))
    for b in range(10):
        writer.commit(encode_block(_records(10, b * 10), b * 10, 0, 0))
    writer.close_segment()

    assert len(list(writer.run_dir.glob("seg-*.wcan"))) > 1
    assert _counters(writer.run_dir) == list(range(100))


def _run_writer_until_drained(tmp_path, frame_count=5000, **config):
    """Runs the writer as in production, with a reader alive until all frames commit."""
    recorder = Recorder(Config(directory=str(tmp_path), commit_ms=1, **config))
    recorder._retry_delay = 0.001
    recorder._queue.extend(_records(frame_count))

    def reader_stand_in():
        deadline = time.monotonic() + 30
        while recorder.committed_frames < frame_count and time.monotonic() < deadline:
            time.sleep(0.001)

    recorder._reader_thread = threading.Thread(target=reader_stand_in, daemon=True)
    recorder._reader_thread.start()
    recorder._writer_loop()
    return recorder


def test_failed_sync_retries_in_a_new_segment_without_loss(tmp_path, monkeypatch):
    real_fdatasync = os.fdatasync
    calls = {"count": 0}

    def flaky(fd):
        calls["count"] += 1
        if calls["count"] == 3:  # the second block reached the file, then its sync failed
            raise OSError(errno.EIO, "I/O error")
        real_fdatasync(fd)

    monkeypatch.setattr(can_recorder.os, "fdatasync", flaky)

    recorder = _run_writer_until_drained(tmp_path)

    report = _report(recorder.writer.run_dir)
    assert _counters(recorder.writer.run_dir) == list(range(5000))
    assert report.duplicate_blocks == 1
    assert report.lost_frames == 0
    assert recorder.writer.segment == 2


def test_full_disk_holds_frames_in_memory_and_resumes(tmp_path, monkeypatch):
    real_write = os.write
    state = {"writes": 0}

    def fills_up(fd, data):
        state["writes"] += 1
        if 3 <= state["writes"] <= 6:
            if state["writes"] == 3:
                return real_write(fd, bytes(data[:1000]))  # a torn partial write
            raise OSError(errno.ENOSPC, "No space left on device")
        return real_write(fd, data)

    monkeypatch.setattr(can_recorder.os, "write", fills_up)

    recorder = _run_writer_until_drained(tmp_path)

    assert _counters(recorder.writer.run_dir) == list(range(5000))
    assert recorder.queue_drops == 0


def test_stopping_with_a_dead_disk_gives_up_and_reports_what_was_lost(tmp_path, monkeypatch, caplog):
    def always_fails(_fd):
        raise OSError(errno.EIO, "I/O error")

    monkeypatch.setattr(can_recorder.os, "fdatasync", always_fails)
    recorder = Recorder(Config(directory=str(tmp_path), commit_ms=1))
    recorder._retry_delay = 0.001
    recorder._queue.extend(_records(10))

    recorder._writer_loop()  # no reader, as during shutdown: this must return

    assert "Giving up with 10 frames unwritten" in caplog.text


def test_status_file_reports_recording_state(tmp_path):
    status_file = tmp_path / "status.json"
    recorder = _run_writer_until_drained(tmp_path / "rec", frame_count=10, status_file=str(status_file))

    status = json.loads(status_file.read_text())
    assert status["state"] == "recording"
    assert status["frames_committed"] == 10
    assert status["queue_drops"] == 0
    assert recorder.committed_frames == 10


def test_recording_code_uses_only_the_standard_library():
    """The unit runs under the system Python with no venv, so this must stay true."""
    env = {"PATH": os.environ.get("PATH", "")}
    code = "import src.can_recorder, src.canlog, sys; print(sorted({'can', 'redis', 'pyarrow'} & set(sys.modules)))"
    result = subprocess.run(
        [sys.executable, "-S", "-c", code], cwd=UTS_ROOT, env=env,
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "[]"


# ── Export for the server file uploader ──────────────────────────────────────


def _write_frames(root, frames, realtime_ns=BASE_NS, monotonic_ns=0):
    writer = SegmentWriter(Config(directory=str(root)))
    records = [RECORD.pack(ts, can_frame(can_id, data)) for ts, can_id, data in frames]
    writer.commit(encode_block(records, 0, realtime_ns, monotonic_ns))
    writer.close_segment()
    return writer.run_dir


def _read_export(path):
    lines = path.read_text().splitlines()
    return lines[0], [line.split(",") for line in lines[1:]]


def _parse_like_uploader(path, row):
    """Mirrors FileUploader._parse_row and its filename parsing in file-uploader/helper.py."""
    start = datetime.strptime(path.name[:-4], "%Y-%m-%d-%H-%M-%S").replace(tzinfo=ZoneInfo("America/Toronto"))
    assert len(row) >= 11
    values = [int(b) for b in row[3:11] if b]
    assert len(values) == 8
    return (start + timedelta(milliseconds=int(row[0]))).astimezone(timezone.utc), int(row[2]), bytes(values)


def test_export_is_readable_by_the_file_uploader(tmp_path):
    t0 = 1_793_000_000_250_000_000
    run_dir = _write_frames(tmp_path / "rec", [
        (t0, 0x123, b"\x01\x02\x03"),
        (t0 + 5_000_000, CAN_EFF_FLAG | 0x18FF50E5, bytes(range(8))),
        (t0 + 6_000_000, CAN_ERR_FLAG | 0x004, b"\0" * 8),
        (t0 + 7_000_000, CAN_RTR_FLAG | 0x123, b""),
    ], realtime_ns=t0)

    path, source = canlog.export_run(run_dir, tmp_path / "out")
    header, rows = _read_export(path)

    assert source == "pi-clock"
    assert header.startswith("relative_ms,protocol,can_id,byte0")
    assert len(rows) == 2, "error and RTR frames are not data"
    when, can_id, data = _parse_like_uploader(path, rows[0])
    assert when.timestamp() == pytest.approx(t0 / 1e9, abs=0.001)
    assert (can_id, data) == (0x123, b"\x01\x02\x03\0\0\0\0\0")
    when, can_id, data = _parse_like_uploader(path, rows[1])
    assert when.timestamp() == pytest.approx((t0 + 5_000_000) / 1e9, abs=0.001)
    assert (can_id, data) == (0x18FF50E5, bytes(range(8)))


def test_export_prefers_ecu_time_over_a_stale_pi_clock(tmp_path):
    """This Pi has no RTC battery and has been seen booting 8 days behind."""
    true_ms = 1_793_573_512_000
    stale_ns = (true_ms - 8 * 86_400_000) * 1_000_000
    ecu = struct.pack("<q", true_ms)
    run_dir = _write_frames(tmp_path / "rec", [
        (stale_ns, ECU_TIMESTAMP_ID, ecu),
        (stale_ns + 10_000_000, 0x100, b"\x07" * 8),
    ], realtime_ns=stale_ns, monotonic_ns=0)

    path, source = canlog.export_run(run_dir, tmp_path / "out")
    _, rows = _read_export(path)

    assert source == "ecu"
    when, _, _ = _parse_like_uploader(path, rows[1])
    assert when.timestamp() == pytest.approx(true_ms / 1000 + 0.010, abs=0.001)


def test_export_ignores_an_unset_ecu_clock(tmp_path):
    run_dir = _write_frames(tmp_path / "rec", [
        (BASE_NS, ECU_TIMESTAMP_ID, struct.pack("<q", 1000)),
    ])

    _, source = canlog.export_run(run_dir, tmp_path / "out")

    assert source == "pi-clock"


def test_export_of_a_run_with_only_error_frames_writes_nothing(tmp_path):
    run_dir = _write_frames(tmp_path / "rec", [(BASE_NS, CAN_ERR_FLAG | 0x004, b"\0" * 8)])

    assert canlog.export_run(run_dir, tmp_path / "out") is None
    assert list((tmp_path / "out" / run_dir.name).iterdir()) == []


def test_clock_step_during_a_run_is_reported(tmp_path, capsys):
    writer = SegmentWriter(Config(directory=str(tmp_path)))
    writer.commit(encode_block(_records(1), 0, BASE_NS, 0))
    writer.commit(encode_block(_records(1, 1), 1, BASE_NS + 691_200 * 10**9, 0))
    writer.close_segment()

    assert canlog.main(["verify", str(tmp_path)]) == 0
    assert "clock stepped 1x" in capsys.readouterr().out


# ── verify --acks: the durability check used by the power-cut test ───────────


def test_verify_passes_when_every_acknowledged_frame_survived(tmp_path):
    root = tmp_path / "rec"
    _write_run(root, blocks=3, frames_per_block=50)
    acks = tmp_path / "acks.txt"
    acks.write_text("run=1 frames=50\nrun=1 frames=150\n")

    assert canlog.main(["verify", str(root), "--acks", str(acks)]) == 0


def test_verify_fails_when_storage_lost_an_acknowledged_commit(tmp_path, capsys):
    root = tmp_path / "rec"
    run_dir = _write_run(root, blocks=3, frames_per_block=50)
    segment = _single_segment(run_dir)
    block_size = (segment.stat().st_size - SECTOR) // 3
    os.truncate(segment, SECTOR + 2 * block_size)  # the card dropped the last commit
    acks = tmp_path / "acks.txt"
    acks.write_text("run=1 frames=150\n")

    assert canlog.main(["verify", str(root), "--acks", str(acks)]) == 1
    assert "DURABILITY FAILURE" in capsys.readouterr().out


def test_verify_counts_a_lost_middle_block_against_the_acks(tmp_path, capsys):
    root = tmp_path / "rec"
    run_dir = _write_run(root, blocks=3, frames_per_block=50)
    segment = _single_segment(run_dir)
    data = bytearray(segment.read_bytes())
    data[SECTOR + 100] ^= 0xFF
    segment.write_bytes(data)
    acks = tmp_path / "acks.txt"
    acks.write_text("run=1 frames=150\n")

    assert canlog.main(["verify", str(root), "--acks", str(acks)]) == 1
    assert "DURABILITY FAILURE" in capsys.readouterr().out


def test_verify_refuses_to_pass_with_no_acknowledgements(tmp_path, capsys):
    root = tmp_path / "rec"
    _write_run(root, blocks=1, frames_per_block=50)
    acks = tmp_path / "acks.txt"
    acks.write_text("")

    assert canlog.main(["verify", str(root), "--acks", str(acks)]) == 1
    assert "No acknowledgements" in capsys.readouterr().out


def test_verify_fails_when_an_acknowledged_run_disappeared(tmp_path, capsys):
    root = tmp_path / "rec"
    _write_run(root, blocks=1, frames_per_block=50)
    acks = tmp_path / "acks.txt"
    acks.write_text("run=1 frames=50\nrun=2 frames=90\n")

    assert canlog.main(["verify", str(root), "--acks", str(acks)]) == 1
    output = capsys.readouterr().out
    assert "run-000002: missing" in output
    assert "DURABILITY FAILURE" in output


def test_verify_fails_when_a_run_number_was_used_twice(tmp_path, capsys):
    """The first run 1 was lost, then the next boot reused its number and outran it."""
    root = tmp_path / "rec"
    _write_run(root, blocks=3, frames_per_block=50)
    acks = tmp_path / "acks.txt"
    acks.write_text("run=1 frames=20 recorder=aaaa\nrun=1 frames=150 recorder=bbbb\n")

    assert canlog.main(["verify", str(root), "--acks", str(acks)]) == 1
    assert "two recorders" in capsys.readouterr().out


@pytest.mark.parametrize("encoding, newline", [
    ("utf-8", "\r\n"),  # StreamWriter or Add-Content on Windows
    ("utf-16", "\r\n"),  # a PowerShell `>` redirect
])
def test_acks_written_on_windows_are_readable(tmp_path, encoding, newline):
    acks = tmp_path / "acks.txt"
    lines = ["run=1 frames=50 recorder=aaaa", "run=1 frames=150 recorder=aaaa", "run=2 frames=7 recorder=bbbb"]
    acks.write_bytes(newline.join(lines).encode(encoding))

    assert canlog.read_acks(acks) == ({1: 150, 2: 7}, set())


# ── End to end against a virtual CAN interface ───────────────────────────────


needs_vcan = pytest.mark.skipif(
    not os.path.exists(f"/sys/class/net/{TEST_IFACE}"),
    reason=f"{TEST_IFACE} not present",
)


class _Sender(threading.Thread):
    """Sends frames carrying a counter, so anything missing can be identified."""

    def __init__(self, iface, gap_s=0.0005):
        super().__init__(daemon=True)
        self._sock = socket.socket(socket.PF_CAN, socket.SOCK_RAW, socket.CAN_RAW)
        self._sock.bind((iface,))
        self._gap = gap_s
        self._stop_event = threading.Event()
        self.sent = 0

    def run(self):
        while not self._stop_event.is_set():
            try:
                self._sock.send(can_frame(0x200, struct.pack("<Q", self.sent)))
                self.sent += 1
            except OSError:
                pass  # vcan queue full; the counter still only counts frames sent
            time.sleep(self._gap)

    def stop(self):
        self._stop_event.set()
        self.join()
        self._sock.close()


def _start_recorder(root, ack_port, commit_ms=50):
    return subprocess.Popen(
        [sys.executable, "-m", "src.can_recorder", "--iface", TEST_IFACE, "--dir", str(root),
         "--commit-ms", str(commit_ms), "--ack-udp", f"127.0.0.1:{ack_port}"],
        cwd=UTS_ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def _ack_socket():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("127.0.0.1", 0))
    sock.setblocking(False)
    return sock, sock.getsockname()[1]


def _last_ack(sock):
    last = 0
    while True:
        try:
            message = sock.recv(128).decode()
        except BlockingIOError:
            return last
        last = int(message.split("frames=")[1].split()[0])


def _wait_for_first_commit(root, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for segment in Path(root).glob("run-*/seg-*.wcan"):
            if segment.stat().st_size > SECTOR:
                return
        time.sleep(0.02)
    pytest.fail("recorder made no commit")


def _frames_in_order(run_dir):
    return [
        struct.unpack("<Q", f.data)[0]
        for block in iter_run(run_dir)
        for f in block.frames()
        if f.can_id == 0x200
    ]


@needs_vcan
@pytest.mark.parametrize("kill_after", [0.31, 0.77, 1.13, 1.61, 2.03])
def test_sigkill_keeps_every_acknowledged_frame(tmp_path, kill_after):
    acks, port = _ack_socket()
    sender = _Sender(TEST_IFACE)
    recorder = _start_recorder(tmp_path, port)
    try:
        sender.start()
        _wait_for_first_commit(tmp_path)
        time.sleep(kill_after)
        sent_at_kill = sender.sent
        recorder.send_signal(signal.SIGKILL)
        recorder.wait(timeout=5)
    finally:
        sender.stop()
        if recorder.poll() is None:
            recorder.kill()
    acknowledged = _last_ack(acks)
    acks.close()

    run_dir = canlog.list_runs(tmp_path)[0]
    counters = _frames_in_order(run_dir)
    report = _report(run_dir)

    assert acknowledged > 0
    assert report.frames >= acknowledged, "a commit reported as durable is missing"
    assert report.lost_frames == 0
    assert report.socket_drops == 0
    assert counters == list(range(counters[0], counters[-1] + 1)), "a frame is missing mid-recording"
    # Only frames queued since the last commit may be lost: one interval, and
    # generously one second here, to stay reliable on a loaded CI machine.
    assert sent_at_kill - counters[-1] < 2000


@needs_vcan
def test_sigterm_commits_everything_received(tmp_path):
    acks, port = _ack_socket()
    sender = _Sender(TEST_IFACE)
    recorder = _start_recorder(tmp_path, port, commit_ms=1000)
    try:
        sender.start()
        _wait_for_first_commit(tmp_path)
        time.sleep(0.5)
        sender.stop()
        total = sender.sent
        time.sleep(0.05)
        recorder.send_signal(signal.SIGTERM)
        assert recorder.wait(timeout=10) == 0
    finally:
        if recorder.poll() is None:
            recorder.kill()
    acks.close()

    counters = _frames_in_order(canlog.list_runs(tmp_path)[0])
    assert counters[-1] == total - 1, "a clean stop must leave nothing behind"
    assert counters == list(range(counters[0], total))


def test_recorder_waits_for_a_missing_interface_instead_of_exiting(tmp_path):
    recorder = subprocess.Popen(
        [sys.executable, "-m", "src.can_recorder", "--iface", "nosuchcan0", "--dir", str(tmp_path)],
        cwd=UTS_ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        time.sleep(1.0)
        assert recorder.poll() is None, "must keep retrying until the HAT driver registers can0"
        assert not list(tmp_path.iterdir()), "must not create empty runs before any frame arrives"
    finally:
        recorder.terminate()
        recorder.wait(timeout=5)
