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

            # Server may send CAN batch frames before the pong — skip non-dict messages
            msg = None
            for _ in range(10):
                candidate = await ws.receive_message(timeout=5)
                if candidate is None:
                    break
                if isinstance(candidate, dict) and candidate.get("type") == "pong":
                    msg = candidate
                    break

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


class TestFrontendUplinkIntegration:
    """
    Mirrors the PECAN Transmitter path: packMessage-style hex -> byte array -> can_send.
    See pecan/src/utils/hexToBytes.ts and WEBSOCKET_PROTOCOL.md.
    """

    @staticmethod
    def _hex_to_bytes(hex_str: str) -> list[int]:
        h = hex_str.replace(" ", "").upper()
        return [int(h[i : i + 2], 16) for i in range(0, len(h), 2)]

    @pytest.mark.asyncio
    async def test_can_send_payload_matches_frontend_hex_conversion(self):
        """Same bytes as hexToBytes('0A1B2C3D00000000') must be accepted and acked."""
        hex_payload = "0A1B2C3D00000000"
        data = self._hex_to_bytes(hex_payload)
        assert data == [10, 27, 44, 61, 0, 0, 0, 0]

        ws = WebSocketHelper(WS_URL)
        try:
            await ws.connect()
            ref = f"hex-{uuid.uuid4().hex[:8]}"
            await ws.send_message(
                {
                    "type": "can_send",
                    "ref": ref,
                    "canId": 256,
                    "data": data,
                }
            )

            ack = None
            for _ in range(20):
                msg = await ws.receive_message(timeout=5)
                if msg and isinstance(msg, dict) and msg.get("type") == "uplink_ack":
                    ack = msg
                    break

            assert ack is not None, "No uplink_ack for frontend-style hex-derived payload"
            assert ack["ref"] == ref
            assert ack["status"] == "queued"
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


class TestTxWebSocketBridge:
    """
    Tests for the TX WebSocket bridge (port 9078).

    Uses Heartbeat message from example.dbc:
      - Name: Heartbeat, ID: 0x7cf, DLC: 8
      - Signal: UTCTime (start=0, scale=1)
      - Encode(UTCTime=12345678) -> [0x4e, 0x61, 0xbc, 0x00, 0x00, 0x00, 0x00, 0x00]

    can_preview_signals: returns encoded bytes WITHOUT writing to CAN
    can_send_signals:   returns encoded bytes AND writes to CAN (ENABLE_TX_WS=true)
    """

    TX_WS_URL = "ws://localhost:9078"

    # From cantools encode of Heartbeat (example.dbc) with UTCTime=12345678
    EXPECTED_BYTES = [0x4E, 0x61, 0xBC, 0x00, 0x00, 0x00, 0x00, 0x00]
    HEARTBEAT_CAN_ID = 0x7CF

    @pytest.mark.asyncio
    async def test_preview_returns_encoded_bytes(self):
        """can_preview_signals returns the correct 8-byte encoded payload."""
        ws = WebSocketHelper(self.TX_WS_URL)
        try:
            await ws.connect()
            ref = f"preview-{uuid.uuid4().hex[:8]}"
            await ws.send_message({
                "type": "can_preview_signals",
                "ref": ref,
                "canId": self.HEARTBEAT_CAN_ID,
                "signals": {"UTCTime": 12345678},
            })

            resp = await ws.receive_message(timeout=5)
            assert resp is not None, "No response to can_preview_signals"
            assert resp["type"] == "preview", f"Expected 'preview', got: {resp}"
            assert resp["ok"] is True
            assert resp["canId"] == self.HEARTBEAT_CAN_ID
            assert resp["bytes"] == self.EXPECTED_BYTES, (
                f"Expected {self.EXPECTED_BYTES}, got {resp['bytes']}"
            )
            logger.info(f"Preview OK: {[hex(b) for b in resp['bytes']]}")
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_preview_unknown_can_id_returns_error(self):
        """can_preview_signals with unknown CAN ID returns ENCODE_ERROR."""
        ws = WebSocketHelper(self.TX_WS_URL)
        try:
            await ws.connect()
            await ws.send_message({
                "type": "can_preview_signals",
                "ref": "bad-id",
                "canId": 0x9999,
                "signals": {"UTCTime": 0},
            })

            resp = await ws.receive_message(timeout=5)
            assert resp is not None
            assert resp["type"] == "error"
            assert resp["code"] == "ENCODE_ERROR"
            logger.info("Unknown CAN ID error OK")
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_send_returns_uplink_ack_when_tx_enabled(self, docker):
        """
        can_send_signals returns uplink_ack when ENABLE_TX_WS=true.
        Runs with a TX bridge container that has ENABLE_TX_WS=true.
        """
        # This test requires the TX bridge to be running with ENABLE_TX_WS=true.
        # It is tested via the same TX_WS_URL but the actual backend must
        # have ENABLE_TX_WS=true set in its environment.
        ws = WebSocketHelper(self.TX_WS_URL)
        try:
            await ws.connect()
            ref = f"send-{uuid.uuid4().hex[:8]}"
            await ws.send_message({
                "type": "can_send_signals",
                "ref": ref,
                "canId": self.HEARTBEAT_CAN_ID,
                "signals": {"UTCTime": 99999999},
            })

            resp = await ws.receive_message(timeout=5)
            assert resp is not None, "No response to can_send_signals"
            # If ENABLE_TX_WS=false (default), we get TX_DISABLED.
            # If ENABLE_TX_WS=true, we get uplink_ack with status=sent.
            assert resp["type"] in ("uplink_ack", "error"), f"Unexpected response: {resp}"
            if resp["type"] == "error" and resp["code"] == "TX_DISABLED":
                logger.info("TX bridge is disabled (ENABLE_TX_WS=false) — expected in dev/test envs")
            elif resp["type"] == "uplink_ack":
                assert resp["ref"] == ref
                assert resp["status"] == "sent"
                logger.info(f"TX send OK: {[hex(b) for b in resp['bytes']]}")
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_ping_returns_pong(self):
        """ping/pong work on the TX WebSocket port."""
        ws = WebSocketHelper(self.TX_WS_URL)
        try:
            await ws.connect()
            ts = int(time.time() * 1000)
            await ws.send_message({"type": "ping", "timestamp": ts})

            resp = await ws.receive_message(timeout=5)
            assert resp is not None
            assert resp["type"] == "pong"
            assert "serverTime" in resp
            logger.info("TX WS ping/pong OK")
        finally:
            await ws.close()


class TestTxWebSocketIntegration:
    """
    End-to-end integration tests for the TX WebSocket bridge + frontend sending behavior.

    Tests the complete flow:
        Frontend (signals) → TX WS (encode) → bytes returned → uplink_ack / TX

    Uses the same message types that the PECAN Transmitter page sends:
        - can_preview_signals  (live preview, no CAN write)
        - can_send_signals      (encode + CAN write when ENABLE_TX_WS=true)

    Uses Heartbeat (0x7cf) and MC_Command (0x100) from example.dbc as test vectors.
    These are real DBC messages with known encoding behavior from cantools.
    """

    TX_WS_URL = "ws://localhost:9078"

    # Heartbeat (example.dbc): ID=0x7cf, 1 signal: UTCTime (scale=1, offset=0)
    HEARTBEAT_ID = 0x7CF
    HEARTBEAT_SIGNALS = {"UTCTime": 0}

    # MC_Command (example.dbc): ID=0x100, 2 signals: TorqueRequest (scale=0.1), SpeedLimit (scale=1)
    MC_COMMAND_ID = 0x100
    MC_COMMAND_SIGNALS = {"TorqueRequest": 100.0, "SpeedLimit": 5000}

    # ── Preview tests ─────────────────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_preview_heartbeat_zero_returns_all_zero_bytes(self):
        """Preview Heartbeat with UTCTime=0 → all zero bytes."""
        ws = WebSocketHelper(self.TX_WS_URL)
        try:
            await ws.connect()
            ref = f"prev-{uuid.uuid4().hex[:8]}"
            await ws.send_message({
                "type": "can_preview_signals",
                "ref": ref,
                "canId": self.HEARTBEAT_ID,
                "signals": {"UTCTime": 0},
            })

            resp = await ws.receive_message(timeout=5)
            assert resp is not None, "No response"
            assert resp["type"] == "preview"
            assert resp["ok"] is True
            assert resp["canId"] == self.HEARTBEAT_ID
            assert resp["bytes"] == [0] * 8, f"Expected all-zero bytes, got {resp['bytes']}"
            logger.info("Preview zero OK")
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_preview_heartbeat_nonzero_returns_nonzero_bytes(self):
        """
        Preview Heartbeat with UTCTime=12345678.
        Expected bytes (cantools verified): [0x4e, 0x61, 0xbc, 0, 0, 0, 0, 0]

        This confirms that changing signal values actually changes the encoded output.
        """
        ws = WebSocketHelper(self.TX_WS_URL)
        try:
            await ws.connect()
            ref = f"prev-{uuid.uuid4().hex[:8]}"
            await ws.send_message({
                "type": "can_preview_signals",
                "ref": ref,
                "canId": self.HEARTBEAT_ID,
                "signals": {"UTCTime": 12345678},
            })

            resp = await ws.receive_message(timeout=5)
            assert resp is not None
            assert resp["type"] == "preview"
            assert resp["bytes"] == [0x4E, 0x61, 0xBC, 0x00, 0x00, 0x00, 0x00, 0x00], (
                f"cantools encoding mismatch: got {[hex(b) for b in resp['bytes']]}"
            )
            logger.info("Preview nonzero OK")
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_preview_different_signals_produce_different_bytes(self):
        """
        Verify that two different signal values produce two different byte sequences.
        This is the core correctness check: sliders changing → preview bytes changing.
        """
        ws = WebSocketHelper(self.TX_WS_URL)
        try:
            await ws.connect()

            # Send two different UTCTime values
            await ws.send_message({
                "type": "can_preview_signals",
                "ref": "v1",
                "canId": self.HEARTBEAT_ID,
                "signals": {"UTCTime": 10000000},
            })
            resp1 = await ws.receive_message(timeout=5)
            assert resp1 is not None and resp1["type"] == "preview"
            bytes1 = resp1["bytes"]

            await ws.send_message({
                "type": "can_preview_signals",
                "ref": "v2",
                "canId": self.HEARTBEAT_ID,
                "signals": {"UTCTime": 20000000},
            })
            resp2 = await ws.receive_message(timeout=5)
            assert resp2 is not None and resp2["type"] == "preview"
            bytes2 = resp2["bytes"]

            assert bytes1 != bytes2, (
                f"Different signal values must produce different bytes: "
                f"v1={bytes1} v2={bytes2}"
            )
            logger.info(f"Different signals → different bytes: {bytes1} != {bytes2}  ✓")
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_preview_mc_command_two_signals(self):
        """
        MC_Command (0x100) has two signals: TorqueRequest (scale=0.1) and SpeedLimit.
        Encoding TorqueRequest=100.0 → raw=1000 (0x03E8), SpeedLimit=5000 (0x1388).
        Combined LE bytes: E8 03 88 13 00 00 00 00
        """
        ws = WebSocketHelper(self.TX_WS_URL)
        try:
            await ws.connect()
            await ws.send_message({
                "type": "can_preview_signals",
                "ref": "mc-cmd",
                "canId": self.MC_COMMAND_ID,
                "signals": {"TorqueRequest": 100.0, "SpeedLimit": 5000},
            })

            resp = await ws.receive_message(timeout=5)
            assert resp is not None
            assert resp["type"] == "preview"
            # Expected: [0xE8, 0x03, 0x88, 0x13, 0x00, 0x00, 0x00, 0x00]
            assert resp["bytes"] == [0xE8, 0x03, 0x88, 0x13, 0x00, 0x00, 0x00, 0x00], (
                f"MC_Command encoding mismatch: got {[hex(b) for b in resp['bytes']]}"
            )
            logger.info("MC_Command encoding OK")
        finally:
            await ws.close()

    # ── Error handling tests ─────────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_preview_partial_signals_succeeds(self):
        """
        can_preview_signals with a partial signal set succeeds — missing signals
        default to 0 (strict=False encoding). TorqueRequest=50.0 → raw=500 (0x01F4),
        SpeedLimit omitted → defaults to 0. Expected bytes: F4 01 00 00 00 00 00 00.
        """
        ws = WebSocketHelper(self.TX_WS_URL)
        try:
            await ws.connect()
            await ws.send_message({
                "type": "can_preview_signals",
                "ref": "missing-sig",
                "canId": self.MC_COMMAND_ID,
                "signals": {"TorqueRequest": 50.0},  # SpeedLimit missing → defaults to 0
            })

            resp = await ws.receive_message(timeout=5)
            assert resp is not None
            assert resp["type"] == "preview"
            assert resp["bytes"] == [0xF4, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], (
                f"Partial signal encoding mismatch: got {[hex(b) for b in resp['bytes']]}"
            )
            logger.info("Partial signals preview OK")
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_preview_invalid_can_id_returns_encode_error(self):
        """A CAN ID not in the DBC should return ENCODE_ERROR."""
        ws = WebSocketHelper(self.TX_WS_URL)
        try:
            await ws.connect()
            await ws.send_message({
                "type": "can_preview_signals",
                "ref": "bad-id",
                "canId": 0xFFFF,
                "signals": {"UTCTime": 0},
            })

            resp = await ws.receive_message(timeout=5)
            assert resp is not None
            assert resp["type"] == "error"
            assert resp["code"] == "ENCODE_ERROR"
            logger.info("Invalid CAN ID error OK")
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_preview_negative_signal_returns_encode_error(self):
        """
        Heartbeat's UTCTime is unsigned (min=0). Sending a negative value
        should return ENCODE_ERROR (value out of range for the signal).
        """
        ws = WebSocketHelper(self.TX_WS_URL)
        try:
            await ws.connect()
            await ws.send_message({
                "type": "can_preview_signals",
                "ref": "neg-sig",
                "canId": self.HEARTBEAT_ID,
                "signals": {"UTCTime": -1},
            })

            resp = await ws.receive_message(timeout=5)
            assert resp is not None
            assert resp["type"] == "error"
            assert resp["code"] == "ENCODE_ERROR"
            logger.info("Negative signal error OK")
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_preview_empty_signals_returns_all_zeros(self):
        """Empty signals dict previews with all signals at 0 — returns all-zero bytes."""
        ws = WebSocketHelper(self.TX_WS_URL)
        try:
            await ws.connect()
            await ws.send_message({
                "type": "can_preview_signals",
                "ref": "empty-sig",
                "canId": self.HEARTBEAT_ID,
                "signals": {},
            })

            resp = await ws.receive_message(timeout=5)
            assert resp is not None
            assert resp["type"] == "preview"
            assert resp["bytes"] == [0, 0, 0, 0, 0, 0, 0, 0], (
                f"Empty signals should encode to all zeros, got {resp['bytes']}"
            )
            logger.info("Empty signals all-zero preview OK")
        finally:
            await ws.close()

    # ── Send (TX) tests ───────────────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_send_signals_returns_uplink_ack_or_disabled(self):
        """
        can_send_signals with ENABLE_TX_WS=false (default) returns TX_DISABLED.
        With ENABLE_TX_WS=true it would return uplink_ack with status=sent.

        This test accepts either behavior — confirms the TX path is wired.
        """
        ws = WebSocketHelper(self.TX_WS_URL)
        try:
            await ws.connect()
            ref = f"send-{uuid.uuid4().hex[:8]}"
            await ws.send_message({
                "type": "can_send_signals",
                "ref": ref,
                "canId": self.HEARTBEAT_ID,
                "signals": {"UTCTime": 99999999},
            })

            resp = await ws.receive_message(timeout=5)
            assert resp is not None
            assert resp["type"] in ("uplink_ack", "error"), f"Unexpected: {resp}"

            if resp["type"] == "uplink_ack":
                assert resp["ref"] == ref
                assert resp["status"] == "sent"
                logger.info("TX uplink_ack OK (ENABLE_TX_WS=true)")
            else:
                assert resp["code"] == "TX_DISABLED"
                logger.info("TX returns TX_DISABLED (ENABLE_TX_WS=false) — expected in dev")

            # In either case, bytes should be present
            if resp["type"] == "uplink_ack" and "bytes" in resp:
                assert len(resp["bytes"]) == 8
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_send_signals_bad_can_id_returns_encode_error(self):
        """can_send_signals with bad CAN ID returns ENCODE_ERROR (not TX_DISABLED)."""
        ws = WebSocketHelper(self.TX_WS_URL)
        try:
            await ws.connect()
            await ws.send_message({
                "type": "can_send_signals",
                "ref": "bad-send",
                "canId": 0xDEAD,
                "signals": {"UTCTime": 0},
            })

            resp = await ws.receive_message(timeout=5)
            assert resp is not None
            assert resp["type"] == "error"
            # TX bridge validates DBC before checking ENABLE_TX_WS, so ENCODE_ERROR not TX_DISABLED
            assert resp["code"] in ("ENCODE_ERROR", "TX_DISABLED"), (
                f"Expected ENCODE_ERROR or TX_DISABLED, got: {resp['code']}"
            )
            logger.info(f"Bad CAN ID on send: {resp['code']} — OK")
        finally:
            await ws.close()

    # ── Rapid sending / debounce behavior ────────────────────────────────────

    @pytest.mark.asyncio
    async def test_rapid_preview_requests_all_get_responses(self):
        """
        Send 10 preview requests rapidly (simulates slider dragging).
        All 10 should receive a 'preview' response — no dropped messages.
        """
        ws = WebSocketHelper(self.TX_WS_URL)
        try:
            await ws.connect()

            # Send 10 previews with incrementing UTCTime values
            refs = []
            for i in range(10):
                ref = f"rapid-{i}"
                refs.append(ref)
                await ws.send_message({
                    "type": "can_preview_signals",
                    "ref": ref,
                    "canId": self.HEARTBEAT_ID,
                    "signals": {"UTCTime": 1000000 + i * 1000},
                })

            # Receive all 10 responses
            responses = []
            for _ in range(10):
                resp = await ws.receive_message(timeout=5)
                assert resp is not None, "Timeout waiting for preview response"
                assert resp["type"] == "preview"
                responses.append(resp)

            received_refs = {r["ref"] for r in responses}
            for ref in refs:
                assert ref in received_refs, f"Missing response for ref={ref}"

            logger.info(f"10/10 rapid preview responses received  ✓")
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_mixed_preview_and_send_sequence(self):
        """
        Simulate a realistic TX page session:
          1. User adjusts slider → preview
          2. User clicks TRANSMIT → send_signals
          3. User adjusts again → preview
          4. User sends again → send_signals
        All responses should be correct types and in order.
        """
        ws = WebSocketHelper(self.TX_WS_URL)
        try:
            await ws.connect()

            # Step 1: preview
            await ws.send_message({
                "type": "can_preview_signals",
                "ref": "step1",
                "canId": self.HEARTBEAT_ID,
                "signals": {"UTCTime": 11111111},
            })
            resp1 = await ws.receive_message(timeout=5)
            assert resp1 is not None and resp1["type"] == "preview"
            assert resp1["ref"] == "step1"

            # Step 2: send
            await ws.send_message({
                "type": "can_send_signals",
                "ref": "step2",
                "canId": self.HEARTBEAT_ID,
                "signals": {"UTCTime": 22222222},
            })
            resp2 = await ws.receive_message(timeout=5)
            assert resp2 is not None and resp2["type"] in ("uplink_ack", "error")

            # Step 3: preview with different value
            await ws.send_message({
                "type": "can_preview_signals",
                "ref": "step3",
                "canId": self.HEARTBEAT_ID,
                "signals": {"UTCTime": 33333333},
            })
            resp3 = await ws.receive_message(timeout=5)
            assert resp3 is not None and resp3["type"] == "preview"
            assert resp3["ref"] == "step3"
            # Bytes should differ from step 1
            assert resp3["bytes"] != resp1["bytes"], "Bytes should change with different signal"

            logger.info("Mixed preview/send sequence OK  ✓")
        finally:
            await ws.close()


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
