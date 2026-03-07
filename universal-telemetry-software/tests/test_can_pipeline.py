"""
vCAN pipeline tests — verifies CAN frames flow through the real code path:
  can0 → data.py (can_reader) → Redis → websocket_bridge → WebSocket client

Prerequisites:
  - vcan (or physical) interface `can0` is UP
  - `can-utils` installed on host (provides `cansend`)
  - docker-compose.can-test.yml stack is running
"""
import subprocess
import time
import json
import asyncio
import statistics
import pytest
from tests.test_helpers import (
    RedisHelper,
    WebSocketHelper,
    DockerHelper,
    wait_for_service,
)

CONTAINER = "daq-can-test"
WS_URL = "ws://localhost:9080"
REDIS_CHANNEL = "can_messages"

# DBC-defined CAN IDs
DBC_IDS = {
    192:  "VCU_Status",
    256:  "MC_Command",
    512:  "BMS_Status",
    768:  "Wheel_Speeds",
}
HEARTBEAT_ID = 1999


def cansend(can_id_hex: str, data_hex: str, interface: str = "can0"):
    """Send a single CAN frame via can-utils."""
    frame = f"{can_id_hex}#{data_hex}"
    result = subprocess.run(
        ["cansend", interface, frame],
        capture_output=True, text=True, timeout=5,
    )
    assert result.returncode == 0, f"cansend failed: {result.stderr}"


# ── Fixtures ────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def redis_helper():
    helper = RedisHelper()
    assert wait_for_service(helper.ping, timeout=10), "Redis not reachable"
    yield helper
    helper.close()


@pytest.fixture(scope="module")
def container_running():
    assert DockerHelper.is_container_running(CONTAINER), (
        f"{CONTAINER} is not running — start docker-compose.can-test.yml first"
    )


@pytest.fixture(scope="module")
def container_uses_real_can(container_running):
    """Ensure the container started real CAN, not simulation."""
    logs = DockerHelper.get_container_logs(CONTAINER, tail=100)
    assert "CAN Reader started on can0" in logs, (
        "Container fell back to simulation mode — is can0 up?\n"
        f"Logs:\n{logs}"
    )


# ── TestCANToRedis ──────────────────────────────────────────────────────────

class TestCANToRedis:
    """Verify CAN frames sent on can0 arrive in Redis pub/sub."""

    def test_can_frame_appears_in_redis(self, redis_helper, container_uses_real_can):
        """Send a VCU frame and check it shows up in Redis."""
        redis_helper.subscribe(REDIS_CHANNEL)

        # 0x0C0 = 192 (VCU_Status)
        cansend("0C0", "DEADBEEF01020304")

        # data.py batches at 50 ms / 20 msgs — wait for the batch flush
        msg = redis_helper.get_message(timeout=10)
        assert msg is not None, "No message received on Redis can_messages channel"

        # The message is a list of CAN entries
        assert isinstance(msg, list), f"Expected list, got {type(msg)}"
        ids = [m["canId"] for m in msg]
        assert 192 in ids, f"CAN ID 192 (VCU) not in Redis batch: {ids}"

        # Verify data field
        vcu = next(m for m in msg if m["canId"] == 192)
        assert vcu["data"][:4] == [0xDE, 0xAD, 0xBE, 0xEF], (
            f"Unexpected data bytes: {vcu['data']}"
        )

    def test_heartbeat_appears_in_redis(self, redis_helper, container_uses_real_can):
        """Heartbeat (ID 1999) should be injected by data.py every second."""
        redis_helper.subscribe(REDIS_CHANNEL)

        found = False
        # Heartbeat fires every 1 s; check several batches
        for _ in range(20):
            msg = redis_helper.get_message(timeout=2)
            if msg is None:
                continue
            if any(m["canId"] == HEARTBEAT_ID for m in msg):
                found = True
                break

        assert found, "Heartbeat ID 1999 never appeared in Redis"


# ── TestCANToWebSocket ──────────────────────────────────────────────────────

class TestCANToWebSocket:
    """Verify CAN frames reach a WebSocket client via websocket_bridge."""

    @pytest.mark.asyncio
    async def test_can_frame_arrives_via_websocket(self, container_uses_real_can):
        ws = WebSocketHelper(WS_URL)
        await ws.connect()

        try:
            # Send a BMS frame: 0x200 = 512
            cansend("200", "1122334455667788")

            found = False
            for _ in range(20):
                data = await ws.receive_message(timeout=2)
                if data is None:
                    continue
                entries = data if isinstance(data, list) else [data]
                if any(m.get("canId") == 512 for m in entries):
                    found = True
                    break

            assert found, "CAN ID 512 (BMS) never arrived via WebSocket"
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_heartbeat_arrives_via_websocket(self, container_uses_real_can):
        ws = WebSocketHelper(WS_URL)
        await ws.connect()

        try:
            found = False
            for _ in range(20):
                data = await ws.receive_message(timeout=2)
                if data is None:
                    continue
                entries = data if isinstance(data, list) else [data]
                if any(m.get("canId") == HEARTBEAT_ID for m in entries):
                    found = True
                    break

            assert found, "Heartbeat ID 1999 never arrived via WebSocket"
        finally:
            await ws.close()


# ── TestMultipleCANIDs ──────────────────────────────────────────────────────

class TestMultipleCANIDs:
    """Send all 4 main DBC IDs and verify they all appear in Redis."""

    def test_all_dbc_ids_reach_redis(self, redis_helper, container_uses_real_can):
        redis_helper.subscribe(REDIS_CHANNEL)

        # Send one frame per DBC ID
        cansend("0C0", "0102030405060708")  # 192 VCU
        cansend("100", "0102030405060708")  # 256 MC
        cansend("200", "0102030405060708")  # 512 BMS
        cansend("300", "0102030405060708")  # 768 Wheels

        seen_ids = set()
        for _ in range(30):
            msg = redis_helper.get_message(timeout=2)
            if msg is None:
                continue
            for m in msg:
                seen_ids.add(m["canId"])
            if DBC_IDS.keys() <= seen_ids:
                break

        missing = DBC_IDS.keys() - seen_ids
        assert not missing, f"These DBC IDs never appeared in Redis: {missing}"


# ── TestEventLoopNotBlocked ─────────────────────────────────────────────────

class TestEventLoopNotBlocked:
    """
    Regression guard for the run_in_executor fix.
    Send a burst of CAN frames and verify heartbeats keep arriving —
    proves the event loop is not blocked by bus.recv().
    """

    def test_heartbeats_during_burst(self, redis_helper, container_uses_real_can):
        redis_helper.subscribe(REDIS_CHANNEL)

        # Send 20 frames in quick succession
        for i in range(20):
            data_hex = f"{i:02X}00000000000000"
            cansend("0C0", data_hex)

        # Now look for heartbeats among the messages
        heartbeat_seen = False
        for _ in range(30):
            msg = redis_helper.get_message(timeout=2)
            if msg is None:
                continue
            if any(m["canId"] == HEARTBEAT_ID for m in msg):
                heartbeat_seen = True
                break

        assert heartbeat_seen, (
            "No heartbeat arrived during/after a 20-frame burst — "
            "event loop may be blocked by bus.recv()"
        )


# ── TestPipelineLatency ────────────────────────────────────────────────────

LATENCY_ITERATIONS = 10
# data.py batches at 50 ms / 20 msgs, so sub-200 ms CAN→Redis is expected.
# Full pipeline (CAN→WS) adds Redis pub/sub + bridge forwarding.
MAX_REDIS_LATENCY_MS = 500
MAX_WS_LATENCY_MS = 1000


def _latency_stats(samples_ms: list[float]) -> dict:
    """Return min / avg / p95 / max from a list of latency samples."""
    s = sorted(samples_ms)
    p95_idx = int(len(s) * 0.95) - 1
    return {
        "min":  round(s[0], 2),
        "avg":  round(statistics.mean(s), 2),
        "p95":  round(s[max(p95_idx, 0)], 2),
        "max":  round(s[-1], 2),
        "samples": len(s),
    }


class TestPipelineLatency:
    """
    Measure end-to-end delay from cansend on vcan until the message is
    observable in Redis and at a WebSocket client.
    """

    def test_can_to_redis_latency(self, redis_helper, container_uses_real_can):
        """Send N frames and measure cansend→Redis arrival time."""
        redis_helper.subscribe(REDIS_CHANNEL)
        # Drain any stale messages
        while redis_helper.get_message(timeout=0.5) is not None:
            pass

        latencies: list[float] = []

        for i in range(LATENCY_ITERATIONS):
            marker = (i + 0xA0) & 0xFF
            data_hex = f"{marker:02X}AABBCCDDEEFF00"

            t_send = time.monotonic()
            cansend("0C0", data_hex)

            # Wait for the marker to show up in a Redis batch
            found = False
            for _ in range(40):
                msg = redis_helper.get_message(timeout=0.5)
                if msg is None:
                    continue
                for m in msg:
                    if m["canId"] == 192 and m["data"][0] == marker:
                        t_recv = time.monotonic()
                        latencies.append((t_recv - t_send) * 1000)
                        found = True
                        break
                if found:
                    break

            assert found, f"Iteration {i}: marker 0x{marker:02X} never arrived in Redis"

        stats = _latency_stats(latencies)
        print(f"\n{'─'*60}")
        print(f"  CAN → Redis latency  ({stats['samples']} samples)")
        print(f"    min  {stats['min']:>8.1f} ms")
        print(f"    avg  {stats['avg']:>8.1f} ms")
        print(f"    p95  {stats['p95']:>8.1f} ms")
        print(f"    max  {stats['max']:>8.1f} ms")
        print(f"{'─'*60}")

        assert stats["p95"] < MAX_REDIS_LATENCY_MS, (
            f"CAN→Redis p95 latency {stats['p95']} ms exceeds threshold "
            f"of {MAX_REDIS_LATENCY_MS} ms"
        )

    @pytest.mark.asyncio
    async def test_can_to_websocket_latency(self, container_uses_real_can):
        """Send N frames and measure cansend→WebSocket arrival time."""
        ws = WebSocketHelper(WS_URL)
        await ws.connect()

        # Drain stale messages
        for _ in range(10):
            if await ws.receive_message(timeout=0.3) is None:
                break

        latencies: list[float] = []

        try:
            for i in range(LATENCY_ITERATIONS):
                marker = (i + 0xB0) & 0xFF
                data_hex = f"{marker:02X}FFEEDDCCBBAA00"

                t_send = time.monotonic()
                cansend("0C0", data_hex)

                found = False
                for _ in range(40):
                    data = await ws.receive_message(timeout=0.5)
                    if data is None:
                        continue
                    entries = data if isinstance(data, list) else [data]
                    for m in entries:
                        if m.get("canId") == 192 and isinstance(m.get("data"), list) and m["data"][0] == marker:
                            t_recv = time.monotonic()
                            latencies.append((t_recv - t_send) * 1000)
                            found = True
                            break
                    if found:
                        break

                assert found, f"Iteration {i}: marker 0x{marker:02X} never arrived via WebSocket"

            stats = _latency_stats(latencies)
            print(f"\n{'─'*60}")
            print(f"  CAN → WebSocket latency  ({stats['samples']} samples)")
            print(f"    min  {stats['min']:>8.1f} ms")
            print(f"    avg  {stats['avg']:>8.1f} ms")
            print(f"    p95  {stats['p95']:>8.1f} ms")
            print(f"    max  {stats['max']:>8.1f} ms")
            print(f"{'─'*60}")

            assert stats["p95"] < MAX_WS_LATENCY_MS, (
                f"CAN→WebSocket p95 latency {stats['p95']} ms exceeds threshold "
                f"of {MAX_WS_LATENCY_MS} ms"
            )
        finally:
            await ws.close()
