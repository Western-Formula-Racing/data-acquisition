"""
WFR CAN log: a crash-tolerant on-disk format for raw SocketCAN frames.

Format rules, and the failure each one exists for (the full reasoning is in
deploy/CAN_RECORDER.md):

  * No footer, index or "close" step. A segment is valid at every instant, so
    losing power mid-session costs only the blocks not yet committed. This is
    why the log is not Parquet (pyarrow is already a dependency), whose footer
    is written last: a power cut would lose the whole file.
  * Every commit is one self-checking block (CRC-32) that starts on a 4 KiB
    boundary and is padded to one. Committed bytes are never rewritten, so a
    torn write can only damage the block being written, not earlier ones. The
    alignment also lets a reader resynchronise after damage.
  * Frames are stored as the kernel's untouched `struct can_frame`, keeping the
    DLC and the extended/RTR/error flags that the UDP telemetry format discards.
  * Blocks carry a run-wide frame index, so any lost block is counted exactly.

Standard library only, so this runs on the car under the system Python and on
any laptop.

    python -m src.canlog verify <recording-dir> [--acks acks.txt]
    python -m src.canlog export <recording-dir> <output-dir> [--run N]
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import statistics
import struct
import sys
import zlib
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Iterator, NamedTuple
from zoneinfo import ZoneInfo

SECTOR = 4096
FORMAT_VERSION = 1
FILE_MAGIC = b"WFRCANLG"
BLOCK_MAGIC = b"CBLK"

# magic, version, reserved, run, segment, iface, boot id, realtime ns, monotonic ns
_FILE_HEAD = struct.Struct("<8sHHII16s16sQQ")
_CRC = struct.Struct("<I")
# magic, crc, payload length, frame count, first frame index, realtime ns,
# monotonic ns, then three cumulative loss counters: socket, queue, controller.
BLOCK_HEAD = struct.Struct("<4sIIIQQQQQQ")
# Kernel receive timestamp (ns) followed by a raw 16-byte `struct can_frame`.
RECORD = struct.Struct("<Q16s")
CAN_FRAME = struct.Struct("<IB3x8s")

CAN_EFF_FLAG = 0x80000000
CAN_RTR_FLAG = 0x40000000
CAN_ERR_FLAG = 0x20000000
CAN_EFF_MASK = 0x1FFFFFFF

# VCU_Timestamp: the ECU broadcasts its RTC as int64 LE epoch ms at 1 Hz.
# Same value as ECU_TIMESTAMP_ID in data.py, which cannot be imported from here
# because it pulls in third-party packages.
ECU_TIMESTAMP_ID = 1999
_ECU_EPOCH_MS_MIN = 1_577_836_800_000  # 2020-01-01: rejects unset RTC values
_ECU_EPOCH_MS_MAX = 4_102_444_800_000  # 2100-01-01

_CLOCK_STEP_NS = 1_000_000_000
_RUN_RE = re.compile(r"^run-(\d+)$")
_SEGMENT_RE = re.compile(r"^seg-(\d+)\.wcan$")

# The file uploader reads these filenames as America/Toronto local time.
_UPLOADER_TZ = ZoneInfo("America/Toronto")
_UPLOADER_HEADER = [
    "relative_ms", "protocol", "can_id",
    "byte0", "byte1", "byte2", "byte3", "byte4", "byte5", "byte6", "byte7",
]


class Frame(NamedTuple):
    ts_ns: int
    can_id: int  # raw, including the EFF/RTR/ERR flag bits
    dlc: int
    data: bytes  # always 8 bytes as stored; only the first `dlc` are meaningful


@dataclass(frozen=True)
class SegmentHeader:
    run_id: int
    segment: int
    iface: str
    boot_id: str
    realtime_ns: int
    monotonic_ns: int


@dataclass(frozen=True)
class Block:
    first_frame: int
    frame_count: int
    realtime_ns: int
    monotonic_ns: int
    socket_drops: int
    queue_drops: int
    hw_overruns: int
    payload: bytes

    @property
    def end_frame(self) -> int:
        return self.first_frame + self.frame_count

    @property
    def clock_offset_ns(self) -> int:
        """Wall clock minus monotonic clock when this block was committed."""
        return self.realtime_ns - self.monotonic_ns

    def frames(self) -> Iterator[Frame]:
        for ts_ns, raw in RECORD.iter_unpack(self.payload):
            can_id, dlc, data = CAN_FRAME.unpack(raw)
            yield Frame(ts_ns, can_id, dlc, data)


@dataclass
class SegmentScan:
    path: Path
    header: SegmentHeader | None
    blocks: list[Block]
    damaged_interior: int  # non-zero, invalid sectors with a good block after them
    damaged_tail: int  # the same, after the last good block: what a power cut leaves


@dataclass
class RunReport:
    path: Path
    run_id: int
    segments: int = 0
    blocks: int = 0
    frames: int = 0
    next_frame: int = 0
    lost_frames: int = 0  # frames in blocks that are missing or failed their CRC
    duplicate_blocks: int = 0  # written twice by a retry after a failed sync
    damaged_interior: int = 0
    damaged_tail: int = 0
    bad_headers: int = 0
    socket_drops: int = 0
    queue_drops: int = 0
    hw_overruns: int = 0
    clock_steps: list[int] = field(default_factory=list)

    @property
    def problems(self) -> list[str]:
        found = []
        if self.lost_frames:
            found.append(f"{self.lost_frames} frames lost to damaged blocks")
        if self.damaged_interior:
            found.append(f"{self.damaged_interior} damaged sectors before the end of a segment")
        if self.socket_drops:
            found.append(f"{self.socket_drops} frames dropped by the socket buffer")
        if self.queue_drops:
            found.append(f"{self.queue_drops} frames dropped by the recorder queue")
        if self.hw_overruns:
            found.append(f"{self.hw_overruns} CAN controller overruns (frames never reached Linux)")
        return found


def _padded(length: int) -> int:
    return length + (-length % SECTOR)


def can_frame(can_id: int, data: bytes) -> bytes:
    """Build a raw `struct can_frame`."""
    return CAN_FRAME.pack(can_id, len(data), data.ljust(8, b"\0"))


def encode_file_header(run_id, segment, iface, boot_id, realtime_ns, monotonic_ns) -> bytes:
    head = _FILE_HEAD.pack(
        FILE_MAGIC, FORMAT_VERSION, 0, run_id, segment,
        iface.encode()[:16], bytes.fromhex(boot_id), realtime_ns, monotonic_ns,
    )
    raw = head + _CRC.pack(zlib.crc32(head))
    return raw.ljust(SECTOR, b"\0")


def decode_file_header(data: bytes) -> SegmentHeader | None:
    size = _FILE_HEAD.size
    if len(data) < size + _CRC.size or data[:len(FILE_MAGIC)] != FILE_MAGIC:
        return None
    if zlib.crc32(data[:size]) != _CRC.unpack_from(data, size)[0]:
        return None
    _, version, _, run_id, segment, iface, boot_id, realtime_ns, monotonic_ns = _FILE_HEAD.unpack_from(data)
    if version != FORMAT_VERSION:
        return None
    return SegmentHeader(run_id, segment, iface.rstrip(b"\0").decode(), boot_id.hex(), realtime_ns, monotonic_ns)


def encode_block(records, first_frame, realtime_ns, monotonic_ns,
                 socket_drops=0, queue_drops=0, hw_overruns=0) -> bytes:
    """Encode RECORD-packed frames as one padded, self-checking block."""
    payload = b"".join(records)
    rest = BLOCK_HEAD.pack(
        BLOCK_MAGIC, 0, len(payload), len(records), first_frame,
        realtime_ns, monotonic_ns, socket_drops, queue_drops, hw_overruns,
    )[8:]
    crc = zlib.crc32(payload, zlib.crc32(rest))
    raw = BLOCK_MAGIC + _CRC.pack(crc) + rest + payload
    return raw.ljust(_padded(len(raw)), b"\0")


def _decode_block(data: bytes, offset: int) -> Block | None:
    if data[offset:offset + len(BLOCK_MAGIC)] != BLOCK_MAGIC or offset + BLOCK_HEAD.size > len(data):
        return None
    _, crc, payload_len, count, first, realtime_ns, monotonic_ns, socket_drops, queue_drops, hw_overruns = (
        BLOCK_HEAD.unpack_from(data, offset)
    )
    start = offset + BLOCK_HEAD.size
    end = start + payload_len
    if payload_len != count * RECORD.size or end > len(data):
        return None
    if zlib.crc32(data[offset + 8:end]) != crc:
        return None
    return Block(first, count, realtime_ns, monotonic_ns, socket_drops, queue_drops, hw_overruns, data[start:end])


def scan_segment(path) -> SegmentScan:
    """Recover every valid block, stepping over damage one sector at a time."""
    path = Path(path)
    data = path.read_bytes()
    header = decode_file_header(data[:SECTOR])
    blocks: list[Block] = []
    interior = pending = 0
    offset = SECTOR
    while offset < len(data):
        block = _decode_block(data, offset)
        if block is not None:
            blocks.append(block)
            offset += _padded(BLOCK_HEAD.size + len(block.payload))
            interior += pending
            pending = 0
        else:
            if any(data[offset:offset + SECTOR]):
                pending += 1
            offset += SECTOR
    return SegmentScan(path, header, blocks, interior, pending)


def list_runs(root) -> list[Path]:
    root = Path(root)
    found = [p for p in root.iterdir() if p.is_dir() and _RUN_RE.match(p.name)]
    return sorted(found, key=lambda p: int(_RUN_RE.match(p.name).group(1)))


def _list_segments(run_dir: Path) -> list[Path]:
    found = [p for p in run_dir.iterdir() if _SEGMENT_RE.match(p.name)]
    return sorted(found, key=lambda p: int(_SEGMENT_RE.match(p.name).group(1)))


def iter_run(run_dir, report: RunReport | None = None) -> Iterator[Block]:
    """Yield a run's blocks in frame order, updating *report* as it goes."""
    run_dir = Path(run_dir)
    report = report if report is not None else new_report(run_dir)
    baseline_overruns = None
    last_offset = None
    for path in _list_segments(run_dir):
        scan = scan_segment(path)
        report.segments += 1
        report.damaged_interior += scan.damaged_interior
        report.damaged_tail += scan.damaged_tail
        report.bad_headers += scan.header is None
        for block in scan.blocks:
            if block.end_frame <= report.next_frame:
                report.duplicate_blocks += 1
                continue
            report.lost_frames += block.first_frame - report.next_frame
            report.next_frame = block.end_frame
            report.blocks += 1
            report.frames += block.frame_count
            report.socket_drops = block.socket_drops
            report.queue_drops = block.queue_drops
            # The kernel counter outlives the recorder, so count from this run's start.
            if baseline_overruns is None:
                baseline_overruns = block.hw_overruns
            report.hw_overruns = block.hw_overruns - baseline_overruns
            if last_offset is not None and abs(block.clock_offset_ns - last_offset) > _CLOCK_STEP_NS:
                report.clock_steps.append(block.clock_offset_ns - last_offset)
            last_offset = block.clock_offset_ns
            yield block


def new_report(run_dir) -> RunReport:
    run_dir = Path(run_dir)
    match = _RUN_RE.match(run_dir.name)
    return RunReport(run_dir, int(match.group(1)) if match else -1)


def read_acks(path) -> tuple[dict[int, int], set[int]]:
    """Parse `run=N frames=M recorder=ID` lines from --ack-udp.

    Returns the highest acknowledged M per run, and the runs acknowledged by more
    than one recorder process. Run numbers come from what is on disk, so a number
    is only reused if the earlier run's directory vanished.
    """
    acked: dict[int, int] = {}
    recorders: dict[int, set[str]] = {}
    pattern = re.compile(r"run=(\d+) frames=(\d+)(?: recorder=(\w+))?")
    # NULs are removed because a PowerShell redirect writes UTF-16.
    text = Path(path).read_bytes().replace(b"\0", b"").decode("ascii", "replace")
    for match in pattern.finditer(text):
        run, frames = int(match.group(1)), int(match.group(2))
        acked[run] = max(acked.get(run, 0), frames)
        if match.group(3):
            recorders.setdefault(run, set()).add(match.group(3))
    return acked, {run for run, ids in recorders.items() if len(ids) > 1}


def _ecu_clock_offset_ns(run_dir) -> int | None:
    """Median offset from the monotonic clock to ECU time, from VCU_Timestamp frames."""
    offsets = []
    for block in iter_run(run_dir):
        for frame in block.frames():
            if frame.can_id == ECU_TIMESTAMP_ID and frame.dlc == 8:
                epoch_ms = struct.unpack_from("<q", frame.data)[0]
                if _ECU_EPOCH_MS_MIN < epoch_ms < _ECU_EPOCH_MS_MAX:
                    offsets.append(epoch_ms * 1_000_000 - (frame.ts_ns - block.clock_offset_ns))
    return int(statistics.median(offsets)) if offsets else None


def export_run(run_dir, out_root) -> tuple[Path, str] | None:
    """Write a run as a CSV the server file uploader accepts.

    Returns (csv path, time source), or None when the run has no data frames.
    The Pi can boot with a stale clock, so ECU time is
    preferred. Without it the last wall-clock offset of the run is used, since a
    clock that stepped during the run was most likely corrected.
    """
    run_dir = Path(run_dir)
    offset_ns = _ecu_clock_offset_ns(run_dir)
    source = "ecu"
    if offset_ns is None:
        source = "pi-clock"
        for block in iter_run(run_dir):
            offset_ns = block.clock_offset_ns
    if offset_ns is None:
        return None

    out_dir = Path(out_root) / run_dir.name
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp_path = out_dir / "export.csv.tmp"
    start_s = None
    with open(tmp_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(_UPLOADER_HEADER)
        for block in iter_run(run_dir):
            frame_offset = offset_ns - block.clock_offset_ns
            for frame in block.frames():
                if frame.can_id & (CAN_ERR_FLAG | CAN_RTR_FLAG):
                    continue
                wall_ns = frame.ts_ns + frame_offset
                if start_s is None:
                    start_s = wall_ns // 1_000_000_000
                relative_ms = (wall_ns - start_s * 1_000_000_000) // 1_000_000
                writer.writerow(
                    [relative_ms, "CAN", frame.can_id & CAN_EFF_MASK,
                     *frame.data[:frame.dlc].ljust(8, b"\0")]
                )
    if start_s is None:
        tmp_path.unlink()
        return None
    name = datetime.fromtimestamp(start_s, _UPLOADER_TZ).strftime("%Y-%m-%d-%H-%M-%S") + ".csv"
    final = out_dir / name
    os.replace(tmp_path, final)
    return final, source


def _cmd_verify(args) -> int:
    acked, reused_runs = read_acks(args.acks) if args.acks else ({}, set())
    if args.acks and not acked:
        # Passing here would report a clean test that checked nothing.
        print(f"No acknowledgements found in {args.acks}")
        return 1
    failed = False
    runs = list_runs(args.root)
    if not runs:
        print(f"No runs found in {args.root}")
        return 1
    seen_runs = set()
    for run_dir in runs:
        report = new_report(run_dir)
        for _ in iter_run(run_dir, report):
            pass
        problems = report.problems
        seen_runs.add(report.run_id)
        run_acked = acked.get(report.run_id)
        if report.run_id in reused_runs:
            problems.append(
                "DURABILITY FAILURE: two recorders acknowledged this run number, "
                "so the first one's directory was lost"
            )
        if run_acked is not None and report.next_frame - report.lost_frames < run_acked:
            problems.append(
                f"DURABILITY FAILURE: {run_acked} frames were reported committed, "
                f"only {report.next_frame - report.lost_frames} survived"
            )
        summary = (
            f"{run_dir.name}: {report.frames} frames, {report.blocks} blocks, "
            f"{report.segments} segments"
        )
        if run_acked is not None:
            summary += f", {run_acked} acknowledged"
        if report.damaged_tail:
            summary += f", torn tail ({report.damaged_tail} sectors, expected after a power cut)"
        if report.clock_steps:
            biggest = max(report.clock_steps, key=abs) / 1e9
            summary += f", clock stepped {len(report.clock_steps)}x (largest {biggest:+.0f}s)"
        print(summary)
        for problem in problems:
            print(f"  PROBLEM: {problem}")
        failed = failed or bool(problems)
    for run_id in sorted(set(acked) - seen_runs):
        print(f"run-{run_id:06d}: missing")
        print(f"  PROBLEM: DURABILITY FAILURE: {acked[run_id]} frames were reported committed, "
              "but the run no longer exists")
        failed = True
    return 1 if failed else 0


def _cmd_export(args) -> int:
    runs = list_runs(args.root)
    if args.run is not None:
        runs = [r for r in runs if int(_RUN_RE.match(r.name).group(1)) == args.run]
    if not runs:
        print("No matching runs")
        return 1
    for run_dir in runs:
        result = export_run(run_dir, args.out)
        if result is None:
            print(f"{run_dir.name}: no data frames, skipped")
        else:
            print(f"{run_dir.name}: {result[0]} (time source: {result[1]})")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Inspect WFR CAN recordings")
    sub = parser.add_subparsers(dest="command", required=True)
    verify = sub.add_parser("verify", help="check recordings; exits 1 if data was lost")
    verify.add_argument("root", help="recording directory containing run-* folders")
    verify.add_argument("--acks", help="file of `run=N frames=M` lines from --ack-udp (power-cut test)")
    verify.set_defaults(func=_cmd_verify)
    export = sub.add_parser("export", help="export runs as CSV for the server file uploader")
    export.add_argument("root", help="recording directory containing run-* folders")
    export.add_argument("out", help="output directory")
    export.add_argument("--run", type=int, help="export only this run number")
    export.set_defaults(func=_cmd_export)
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
