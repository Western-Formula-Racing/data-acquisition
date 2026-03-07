"""
WebSocket v2 Protocol Tests — Bidirectional Communication.

Tests the uplink (client -> car) path:
1. WebSocket client sends can_send to bridge
2. Bridge publishes to Redis can_uplink channel
3. Base data.py relays via UDP (0xCAFE header) to car
4. Car data.py receives and logs the uplink message

Also tests protocol-level features:
- ping/pong keepalive
- uplink_ack responses
- error responses for invalid messages
- rate limiting
- batch uplink messages
"""
import pytest
import asyncio
import time
import uuid
import logging
from .test_helpers import (
    RedisHelper,
    WebSocketHelper,
    DockerHelper,
    wait_for_service,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Container names from docker-compose.test.yml
CAR_CONTAINER = "daq-car"
BASE_CONTAINER = "daq-base"

# Service endpoints
REDIS_HOST = "localhost"
REDIS_PORT = 6379
WS_URL = "ws://localhost:9080"


@pytest.fixture(scope="module")
def docker():
    return DockerHelper()


@pytest.fixture(scope="module")
def redis_helper():
    helper = RedisHelper(host=REDIS_HOST, port=REDIS_PORT)
    yield helper
    helper.close()


class TestWebSocketV2PingPong:
    """Test ping/pong keepalive mechanism."""

    @pytest.mark.asyncio
    async def test_ping_returns_pong(self):
        """Client sends ping, server responds with pong including timestamps."""
        ws = WebSocketHelper(WS_URL)
        try:
            await ws.connect()
            ts = int(time.time() * 1000)
            await ws.send_message({"type": "ping", "timestamp": ts})
            msg = await ws.receive_message(timeout=5)

            assert msg is not None, "No pong response received"
            assert msg["type"] == "pong"
            assert msg["timestamp"] == ts, "Echoed timestamp mismatch"
            assert "serverTime" in msg, "Missing serverTime in pong"
            logger.info(f"Ping/pong OK: latency ~{msg['serverTime'] - ts}ms")
        finally:
            await ws.close()


class TestWebSocketV2UplinkAck:
    """Test uplink can_send with acknowledgement."""

    @pytest.mark.asyncio
    async def test_can_send_returns_ack(self):
        """Valid can_send message returns uplink_ack with status queued."""
        ws = WebSocketHelper(WS_URL)
        try:
            await ws.connect()
            ref = str(uuid.uuid4())[:8]
            await ws.send_message({
                "type": "can_send",
                "ref": ref,
                "canId": 256,
                "data": [0, 0, 100, 0, 0, 0, 0, 0],
            })

            # Read messages until we get the ack (skip downlink data)
            ack = None
            for _ in range(20):
                msg = await ws.receive_message(timeout=5)
                if msg and isinstance(msg, dict) and msg.get("type") == "uplink_ack":
                    ack = msg
                    break

            assert ack is not None, "No uplink_ack received"
            assert ack["ref"] == ref
            assert ack["status"] == "queued", \
                "Base mode must return 'queued' (message goes via Redis relay, not written directly)"
            logger.info(f"Uplink ack OK: ref={ref}")
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_can_send_publishes_to_redis(self, redis_helper):
        """can_send message is published to Redis can_uplink channel."""
        redis_helper.subscribe("can_uplink")

        ws = WebSocketHelper(WS_URL)
        try:
            await ws.connect()
            ref = f"test-{uuid.uuid4().hex[:6]}"
            await ws.send_message({
                "type": "can_send",
                "ref": ref,
                "canId": 512,
                "data": [1, 2, 3, 4, 5, 6, 7, 8],
            })

            # Check Redis received it
            uplink_msg = redis_helper.get_message(timeout=5)
            assert uplink_msg is not None, "No message on can_uplink Redis channel"
            assert uplink_msg["ref"] == ref
            assert uplink_msg["canId"] == 512
            assert uplink_msg["data"] == [1, 2, 3, 4, 5, 6, 7, 8]
            assert "source" in uplink_msg
            assert "timestamp" in uplink_msg
            logger.info(f"Redis uplink publish OK: {uplink_msg}")
        finally:
            await ws.close()


class TestWebSocketV2UplinkRelay:
    """Test that base relays uplink to car via UDP and car receives it."""

    @pytest.mark.asyncio
    async def test_uplink_reaches_car(self, docker):
        """End-to-end: WS can_send -> Redis -> base UDP relay -> car receives."""
        ws = WebSocketHelper(WS_URL)
        try:
            await ws.connect()
            ref = f"e2e-{uuid.uuid4().hex[:6]}"
            await ws.send_message({
                "type": "can_send",
                "ref": ref,
                "canId": 256,
                "data": [0, 0, 50, 0, 0, 0, 0, 0],
            })

            # Wait for ack
            ack = None
            for _ in range(20):
                msg = await ws.receive_message(timeout=5)
                if msg and isinstance(msg, dict) and msg.get("type") == "uplink_ack":
                    ack = msg
                    break
            assert ack is not None, "No uplink_ack received"

            # Give time for relay through base -> UDP -> car
            await asyncio.sleep(3)

            # Check base logs for relay confirmation
            base_logs = docker.get_container_logs(BASE_CONTAINER, tail=100)
            assert "Uplink relayed to car" in base_logs, \
                f"Base did not relay uplink. Logs: {base_logs[-500:]}"
            logger.info("Base relayed uplink to car via UDP")

            # Check car logs for receipt
            car_logs = docker.get_container_logs(CAR_CONTAINER, tail=100)
            assert "Uplink received (sim)" in car_logs or "Uplink CAN write" in car_logs, \
                f"Car did not receive uplink. Logs: {car_logs[-500:]}"
            logger.info("Car received uplink message")
        finally:
            await ws.close()


class TestWebSocketV2Errors:
    """Test error responses for invalid uplink messages."""

    @pytest.mark.asyncio
    async def test_invalid_json(self):
        """Malformed JSON returns INVALID_MESSAGE error."""
        ws = WebSocketHelper(WS_URL)
        try:
            await ws.connect()
            # Send raw invalid JSON
            await ws.websocket.send("not valid json{{{")

            err = None
            for _ in range(20):
                msg = await ws.receive_message(timeout=5)
                if msg and isinstance(msg, dict) and msg.get("type") == "error":
                    err = msg
                    break

            assert err is not None, "No error response for invalid JSON"
            assert err["code"] == "INVALID_MESSAGE"
            logger.info(f"Invalid JSON error OK: {err['code']}")
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_unknown_type(self):
        """Unknown message type returns UNKNOWN_TYPE error."""
        ws = WebSocketHelper(WS_URL)
        try:
            await ws.connect()
            await ws.send_message({"type": "nonexistent_action"})

            err = None
            for _ in range(20):
                msg = await ws.receive_message(timeout=5)
                if msg and isinstance(msg, dict) and msg.get("type") == "error":
                    err = msg
                    break

            assert err is not None, "No error response for unknown type"
            assert err["code"] == "UNKNOWN_TYPE"
            logger.info(f"Unknown type error OK: {err['code']}")
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_invalid_can_id(self):
        """Negative canId returns INVALID_CAN_ID error."""
        ws = WebSocketHelper(WS_URL)
        try:
            await ws.connect()
            await ws.send_message({
                "type": "can_send",
                "ref": "test-bad-id",
                "canId": -1,
                "data": [0, 0, 0, 0],
            })

            err = None
            for _ in range(20):
                msg = await ws.receive_message(timeout=5)
                if msg and isinstance(msg, dict) and msg.get("type") == "error":
                    err = msg
                    break

            assert err is not None, "No error response for invalid CAN ID"
            assert err["code"] == "INVALID_CAN_ID"
            logger.info(f"Invalid CAN ID error OK: {err['code']}")
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_invalid_data_too_long(self):
        """Data array > 8 bytes returns INVALID_DATA error."""
        ws = WebSocketHelper(WS_URL)
        try:
            await ws.connect()
            await ws.send_message({
                "type": "can_send",
                "ref": "test-bad-data",
                "canId": 256,
                "data": [0] * 9,
            })

            err = None
            for _ in range(20):
                msg = await ws.receive_message(timeout=5)
                if msg and isinstance(msg, dict) and msg.get("type") == "error":
                    err = msg
                    break

            assert err is not None, "No error response for oversized data"
            assert err["code"] == "INVALID_DATA"
            logger.info(f"Invalid data error OK: {err['code']}")
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_missing_ref(self):
        """Missing ref field returns INVALID_REF error."""
        ws = WebSocketHelper(WS_URL)
        try:
            await ws.connect()
            await ws.send_message({
                "type": "can_send",
                "canId": 256,
                "data": [0, 0, 0, 0],
            })

            err = None
            for _ in range(20):
                msg = await ws.receive_message(timeout=5)
                if msg and isinstance(msg, dict) and msg.get("type") == "error":
                    err = msg
                    break

            assert err is not None, "No error response for missing ref"
            assert err["code"] == "INVALID_REF"
            logger.info(f"Missing ref error OK: {err['code']}")
        finally:
            await ws.close()


class TestWebSocketV2Batch:
    """Test batch uplink messages."""

    @pytest.mark.asyncio
    async def test_batch_send_ack(self):
        """can_send_batch returns single uplink_ack for the batch."""
        ws = WebSocketHelper(WS_URL)
        try:
            await ws.connect()
            ref = f"batch-{uuid.uuid4().hex[:6]}"
            await ws.send_message({
                "type": "can_send_batch",
                "ref": ref,
                "messages": [
                    {"canId": 192, "data": [1, 0, 0, 0, 0, 0, 0, 0]},
                    {"canId": 256, "data": [0, 0, 75, 0, 0, 0, 0, 0]},
                    {"canId": 512, "data": [0, 0, 0, 0, 100, 0, 0, 0]},
                ],
            })

            ack = None
            for _ in range(20):
                msg = await ws.receive_message(timeout=5)
                if msg and isinstance(msg, dict) and msg.get("type") == "uplink_ack":
                    ack = msg
                    break

            assert ack is not None, "No uplink_ack for batch"
            assert ack["ref"] == ref
            assert ack["status"] == "queued", \
                "Base mode must return 'queued' (batch goes via Redis relay, not written directly)"
            logger.info(f"Batch ack OK: ref={ref}")
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_batch_too_large(self):
        """Batch > 20 messages returns BATCH_TOO_LARGE error."""
        ws = WebSocketHelper(WS_URL)
        try:
            await ws.connect()
            await ws.send_message({
                "type": "can_send_batch",
                "ref": "big-batch",
                "messages": [{"canId": 256, "data": [0]} for _ in range(21)],
            })

            err = None
            for _ in range(20):
                msg = await ws.receive_message(timeout=5)
                if msg and isinstance(msg, dict) and msg.get("type") == "error":
                    err = msg
                    break

            assert err is not None, "No error for oversized batch"
            assert err["code"] == "BATCH_TOO_LARGE"
            logger.info(f"Batch too large error OK: {err['code']}")
        finally:
            await ws.close()


class TestWebSocketV2RateLimit:
    """Test per-client rate limiting."""

    @pytest.mark.asyncio
    async def test_rate_limit_exceeded(self):
        """Sending > 10 msg/sec triggers RATE_LIMITED error."""
        ws = WebSocketHelper(WS_URL)
        try:
            await ws.connect()

            rate_limited = False
            # Send 15 messages rapidly (limit is 10/sec)
            for i in range(15):
                await ws.send_message({
                    "type": "can_send",
                    "ref": f"rl-{i}",
                    "canId": 256,
                    "data": [i, 0, 0, 0, 0, 0, 0, 0],
                })

            # Drain responses and look for RATE_LIMITED
            for _ in range(30):
                msg = await ws.receive_message(timeout=3)
                if msg is None:
                    break
                if isinstance(msg, dict) and msg.get("code") == "RATE_LIMITED":
                    rate_limited = True
                    break

            assert rate_limited, "Rate limiting was not triggered after 15 rapid messages"
            logger.info("Rate limiting OK")
        finally:
            await ws.close()


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
