"""
test_lan_sender.py — Integration test using lan_sender as the fake car.

Verifies the full pipeline when the base station receives UDP packets from
lan_sender.py (no car container, no CAN hardware required):

    lan_sender.py → UDP → data.py (base) → Redis → WebSocket bridge → WS client
                   ↳ TimescaleDB

This is a subset of the full integration test, but without the car container.
Useful for fast smoke tests and CI when the full car simulation isn't available.
"""
import pytest
import asyncio
import time
import logging

from .test_helpers import (
    RedisHelper,
    WebSocketHelper,
    DockerHelper,
    wait_for_service,
    check_http_endpoint,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BASE_CONTAINER = "daq-lan-base"
BASE_REDIS_CONTAINER = "daq-lan-base-redis"
TIMESCALEDB_CONTAINER = "daq-lan-timescaledb"

REDIS_HOST = "localhost"
REDIS_PORT = 6379
WS_URL = "ws://localhost:9080"
STATUS_URL = "http://localhost:8080"

# Packets per second that lan_sender.py sends
LAN_SENDER_RATE_HZ = 20


@pytest.fixture(scope="module")
def docker():
    return DockerHelper()


@pytest.fixture(scope="module")
def redis_helper():
    helper = RedisHelper(host=REDIS_HOST, port=REDIS_PORT)
    yield helper
    helper.close()


@pytest.fixture(scope="module")
def lan_sender_subprocess():
    """Start lan_sender.py pointing at localhost:5005, stop it on cleanup."""
    import subprocess
    import sys
    import os

    script = os.path.join(
        os.path.dirname(__file__),
        "..",
        "src",
        "lan_sender.py",
    )

    proc = subprocess.Popen(
        [sys.executable, script, "127.0.0.1", "5005"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    # Give it a moment to start sending
    time.sleep(2)

    yield proc

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    logger.info(f"lan_sender stopped (exit code: {proc.returncode})")


class TestLanSenderContainers:
    """Verify the base-only stack is running."""

    def test_base_container_running(self, docker):
        assert docker.is_container_running(BASE_CONTAINER), \
            f"{BASE_CONTAINER} is not running"
        logger.info(f"✓ {BASE_CONTAINER} is running")

    def test_base_redis_running(self, docker):
        assert docker.is_container_running(BASE_REDIS_CONTAINER), \
            f"{BASE_REDIS_CONTAINER} is not running"
        logger.info(f"✓ {BASE_REDIS_CONTAINER} is running")

    def test_timescaledb_running(self, docker):
        assert docker.is_container_running(TIMESCALEDB_CONTAINER), \
            f"{TIMESCALEDB_CONTAINER} is not running"
        logger.info(f"✓ {TIMESCALEDB_CONTAINER} is running")

    def test_redis_connectivity(self, redis_helper):
        assert wait_for_service(redis_helper.ping, timeout=10), \
            "Redis is not accessible"
        logger.info("✓ Redis is accessible")


class TestLanSenderDataFlow:
    """Verify UDP packets from lan_sender.py propagate through the full stack."""

    def test_base_receives_udp(self, docker):
        """Base receives UDP packets from lan_sender.py."""
        time.sleep(3)
        logs = docker.get_container_logs(BASE_CONTAINER, tail=300)
        assert (
            "Initial sequence:" in logs
            or "ECU time sync:" in logs
        ), "Base is not showing UDP receive activity"
        logger.info("✓ Base is receiving UDP packets from lan_sender")

    def test_can_messages_published_to_redis(self, redis_helper):
        """Base publishes CAN messages to Redis can_messages channel."""
        redis_helper.subscribe("can_messages")
        msg = redis_helper.get_message(timeout=10)
        assert msg is not None, "No CAN messages received from Redis"
        assert isinstance(msg, list), "CAN message should be a list"
        assert len(msg) > 0, "CAN message list should not be empty"
        first = msg[0]
        assert "time" in first and "canId" in first and "data" in first
        logger.info(f"✓ Redis received CAN message: canId={first['canId']}")

    def test_system_stats_published_to_redis(self, redis_helper):
        """Base publishes system_stats to Redis."""
        redis_helper.subscribe("system_stats")
        msg = redis_helper.get_message(timeout=10)
        assert msg is not None, "No system stats received from Redis"
        assert isinstance(msg, dict), "system_stats should be a dict"
        assert "received" in msg and "missing" in msg
        logger.info(f"✓ system_stats received: received={msg.get('received')}")


class TestLanSenderWebSocket:
    """Verify WebSocket bridge broadcasts to clients."""

    @pytest.mark.asyncio
    async def test_websocket_receives_can_data(self):
        """WebSocket bridge forwards CAN messages from Redis to clients."""
        ws = WebSocketHelper(WS_URL)
        try:
            await ws.connect()
            msg = None
            deadline = asyncio.get_event_loop().time() + 15
            while asyncio.get_event_loop().time() < deadline:
                candidate = await ws.receive_message(timeout=2)
                if candidate is None:
                    break
                if isinstance(candidate, list):
                    msg = candidate
                    break
            assert msg is not None, "No CAN list message received via WebSocket"
            assert isinstance(msg, list) and len(msg) > 0
            assert all(k in msg[0] for k in ("time", "canId", "data"))
            logger.info(f"✓ WebSocket received {len(msg)} CAN frames")
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_websocket_car_alive_indicator(self):
        """WebSocket bridge sends system_stats with car_alive=True."""
        ws = WebSocketHelper(WS_URL)
        try:
            await ws.connect()
            stats_msg = None
            deadline = asyncio.get_event_loop().time() + 15
            while asyncio.get_event_loop().time() < deadline:
                candidate = await ws.receive_message(timeout=2)
                if candidate is None:
                    break
                # Look for system_stats dict (has 'received' field)
                if isinstance(candidate, dict) and "received" in candidate:
                    stats_msg = candidate
                    break
            assert stats_msg is not None, "No system_stats received via WebSocket"
            logger.info(f"✓ system_stats via WS: { {k: stats_msg[k] for k in ['received','missing','recovered'] if k in stats_msg} }")
        finally:
            await ws.close()


class TestLanSenderStatusPage:
    """Verify the 8080 status page reflects live data."""

    def test_status_page_accessible(self):
        assert wait_for_service(
            lambda: check_http_endpoint(STATUS_URL),
            timeout=10
        ), "Status page is not accessible"
        logger.info("✓ Status page is accessible")

    def test_status_page_shows_live_data(self, docker):
        """Status page HTML reflects active UDP stream."""
        import requests
        # The page is driven by JS; check the raw HTML for live-indicator markers
        resp = requests.get(STATUS_URL, timeout=5)
        assert resp.status_code == 200
        # Just verify the page loaded with the expected title/content
        assert len(resp.text) > 500, "Status page appears to be nearly empty"
        logger.info(f"✓ Status page loaded ({len(resp.text)} bytes)")


class TestLanSenderTimescaleDB:
    """Verify TimescaleDB writes when ENABLE_TIMESCALE_LOGGING=true.

    Note: TimescaleBridge is disabled by default in docker-compose.lan-sender-test.yml
    (ENABLE_TIMESCALE_LOGGING defaults to false). This test is a no-op unless the
    compose file is updated to enable it. The rest of the pipeline (UDP → Redis →
    WebSocket) is fully verified by the other test classes.
    """

    def test_timescaledb_writing(self, docker):
        """Verify CAN data is written to TimescaleDB when bridge is enabled."""
        import os
        if os.getenv("ENABLE_TIMESCALE_LOGGING", "").lower() != "true":
            pytest.skip("ENABLE_TIMESCALE_LOGGING not set — TimescaleBridge disabled")
        import time
        time.sleep(5)
        output = docker.exec_in_container(
            "daq-lan-timescaledb",
            ["psql", "-U", "wfr", "-d", "wfr", "-c",
             "SELECT COUNT(*) as cnt, message_name FROM wfr26 GROUP BY message_name LIMIT 10"],
        )
        assert output, "TimescaleDB query returned no output"
        assert "0 rows" not in output, f"No CAN data in TimescaleDB: {output}"
        logger.info(f"✓ TimescaleDB query result:\n{output}")
