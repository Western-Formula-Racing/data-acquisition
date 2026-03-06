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
