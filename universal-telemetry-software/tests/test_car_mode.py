"""
Car-mode WebSocket tests — direct CAN bus write path.

Tests the ROLE=car path where the WebSocket bridge writes
directly to the CAN bus (can0) instead of relaying through Redis/UDP.

Coverage:
  Unit:
    - _init_can_bus(): all 4 branches
    - _write_can_message(): _can_bus=None (sim), _can_bus present, bus.send() raises
  Protocol (in-process WS server, no Docker):
    - can_send → uplink_ack status="sent"
    - can_send does NOT publish to Redis
    - can_send_batch → uplink_ack status="sent"
    - can_send_batch fails mid-batch → CAN_WRITE_FAILED
    - UPLINK_DISABLED still applies in car mode
    - Error codes unchanged from base mode
"""
import sys
import os
import pytest
import pytest_asyncio
import asyncio
import json
import uuid
import logging
from unittest.mock import MagicMock, patch, AsyncMock
import websockets

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import src.websocket_bridge as wb
from .test_helpers import WebSocketHelper, RedisHelper

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# In-process test server uses a different port to avoid collisions with Docker tests
TEST_WS_PORT = 9091
TEST_WS_URL = f"ws://127.0.0.1:{TEST_WS_PORT}"

REDIS_HOST = "localhost"
REDIS_PORT = 6379


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def reset_rate_limit_state():
    """Clear per-client rate-limit state between tests."""
    wb._client_send_times.clear()
    yield
    wb._client_send_times.clear()


@pytest_asyncio.fixture
async def car_ws_server():
    """
    Spin up an in-process WebSocket server with ROLE=car and ENABLE_UPLINK=true.
    _can_bus is a MagicMock so no real hardware is needed.
    Yields (url, mock_can_bus).
    """
    mock_bus = MagicMock()
    with (
        patch.object(wb, 'ROLE', 'car'),
        patch.object(wb, 'ENABLE_UPLINK', True),
        patch.object(wb, '_can_bus', mock_bus),
    ):
        async with websockets.serve(wb.ws_handler, "127.0.0.1", TEST_WS_PORT):
            yield TEST_WS_URL, mock_bus


@pytest_asyncio.fixture
async def car_ws_server_uplink_disabled():
    """In-process car server with ENABLE_UPLINK=false."""
    with (
        patch.object(wb, 'ROLE', 'car'),
        patch.object(wb, 'ENABLE_UPLINK', False),
        patch.object(wb, '_can_bus', None),
    ):
        async with websockets.serve(wb.ws_handler, "127.0.0.1", TEST_WS_PORT):
            yield TEST_WS_URL


# ---------------------------------------------------------------------------
# Unit: _init_can_bus
# ---------------------------------------------------------------------------

class TestInitCanBus:
    """_init_can_bus() opens CAN bus only when ROLE=car and ENABLE_UPLINK=true."""

    def test_base_mode_is_noop(self):
        """Does nothing when ROLE=base."""
        with (
            patch.object(wb, 'ROLE', 'base'),
            patch.object(wb, 'ENABLE_UPLINK', True),
            patch.object(wb, '_can_bus', None),
            patch('src.websocket_bridge.can', create=True) as mock_can,
        ):
            wb._init_can_bus()
            mock_can.interface.Bus.assert_not_called()

    def test_uplink_disabled_is_noop(self):
        """Does nothing when ENABLE_UPLINK=false, even if ROLE=car."""
        with (
            patch.object(wb, 'ROLE', 'car'),
            patch.object(wb, 'ENABLE_UPLINK', False),
            patch.object(wb, '_can_bus', None),
            patch('src.websocket_bridge.can', create=True) as mock_can,
        ):
            wb._init_can_bus()
            mock_can.interface.Bus.assert_not_called()

    def test_car_simulate_mode_skips_hardware(self):
        """SIMULATE=true skips opening CAN bus."""
        with (
            patch.object(wb, 'ROLE', 'car'),
            patch.object(wb, 'ENABLE_UPLINK', True),
            patch.object(wb, '_can_bus', None),
            patch.dict(os.environ, {'SIMULATE': 'true'}),
            patch('builtins.__import__', side_effect=lambda name, *a, **kw: __import__(name, *a, **kw)),
        ):
            # Should complete without touching CAN hardware
            with patch('src.websocket_bridge.can', create=True) as mock_can:
                wb._init_can_bus()
                mock_can.interface.Bus.assert_not_called()

    def test_car_hardware_available_opens_bus(self):
        """Opens can0 when hardware is present."""
        mock_can = MagicMock()
        mock_bus_instance = MagicMock()
        mock_can.interface.Bus.return_value = mock_bus_instance

        with (
            patch.object(wb, 'ROLE', 'car'),
            patch.object(wb, 'ENABLE_UPLINK', True),
            patch.dict(os.environ, {'SIMULATE': 'false'}),
        ):
            with patch.dict('sys.modules', {'can': mock_can}):
                wb._can_bus = None  # ensure clean state
                wb._init_can_bus()
                mock_can.interface.Bus.assert_called_once_with(
                    channel='can0', bustype='socketcan'
                )
                assert wb._can_bus is mock_bus_instance

    def test_car_hardware_unavailable_logs_warning(self, caplog):
        """Logs a warning and leaves _can_bus=None when hardware is absent."""
        mock_can = MagicMock()
        mock_can.interface.Bus.side_effect = OSError("No such device: can0")

        with (
            patch.object(wb, 'ROLE', 'car'),
            patch.object(wb, 'ENABLE_UPLINK', True),
            patch.dict(os.environ, {'SIMULATE': 'false'}),
            patch.dict('sys.modules', {'can': mock_can}),
        ):
            wb._can_bus = None
            with caplog.at_level(logging.WARNING, logger='WebSocketBridge'):
                wb._init_can_bus()
            assert wb._can_bus is None
            assert any('could not open' in r.message.lower() for r in caplog.records)


# ---------------------------------------------------------------------------
# Unit: _write_can_message
# ---------------------------------------------------------------------------

class TestWriteCanMessage:

    def test_no_bus_logs_only(self, caplog):
        """When _can_bus is None (sim), message is logged but no send call."""
        with patch.object(wb, '_can_bus', None):
            with caplog.at_level(logging.INFO, logger='WebSocketBridge'):
                wb._write_can_message(256, [0, 0, 100, 0, 0, 0, 0, 0], 'ref-sim')
            assert any('sim' in r.message.lower() for r in caplog.records)

    def test_bus_present_calls_send(self):
        """When _can_bus is set, constructs Message and calls bus.send()."""
        mock_bus = MagicMock()
        mock_can = MagicMock()
        mock_msg_instance = MagicMock()
        mock_can.Message.return_value = mock_msg_instance

        with (
            patch.object(wb, '_can_bus', mock_bus),
            patch.dict('sys.modules', {'can': mock_can}),
        ):
            wb._write_can_message(256, [1, 2, 3, 4, 5, 6, 7, 8], 'ref-hw')

        mock_can.Message.assert_called_once_with(
            arbitration_id=256,
            data=bytes([1, 2, 3, 4, 5, 6, 7, 8]),
            is_extended_id=False,   # 256 <= 0x7FF
        )
        mock_bus.send.assert_called_once_with(mock_msg_instance)

    def test_extended_can_id_sets_flag(self):
        """CAN IDs > 0x7FF set is_extended_id=True."""
        mock_bus = MagicMock()
        mock_can = MagicMock()

        with (
            patch.object(wb, '_can_bus', mock_bus),
            patch.dict('sys.modules', {'can': mock_can}),
        ):
            wb._write_can_message(0x1FFFFFFF, [0], 'ref-ext')

        _, kwargs = mock_can.Message.call_args
        assert kwargs['is_extended_id'] is True

    def test_bus_send_exception_propagates(self):
        """Exceptions from bus.send() are re-raised so the caller can respond."""
        mock_bus = MagicMock()
        mock_bus.send.side_effect = OSError("CAN bus error")
        mock_can = MagicMock()
        mock_can.Message.return_value = MagicMock()

        with (
            patch.object(wb, '_can_bus', mock_bus),
            patch.dict('sys.modules', {'can': mock_can}),
        ):
            with pytest.raises(OSError, match="CAN bus error"):
                wb._write_can_message(256, [0, 0, 0, 0], 'ref-fail')


# ---------------------------------------------------------------------------
# Protocol: car mode (in-process server)
# ---------------------------------------------------------------------------

class TestCarModeCanSend:
    """can_send in car mode writes to CAN bus and returns status="sent"."""

    @pytest.mark.asyncio
    async def test_ack_status_is_sent(self, car_ws_server):
        url, _ = car_ws_server
        ws = WebSocketHelper(url)
        try:
            await ws.connect()
            ref = f"car-{uuid.uuid4().hex[:6]}"
            await ws.send_message({
                "type": "can_send",
                "ref": ref,
                "canId": 256,
                "data": [0, 0, 100, 0, 0, 0, 0, 0],
            })
            ack = await ws.receive_message(timeout=5)
            assert ack is not None, "No ack received"
            assert ack["type"] == "uplink_ack"
            assert ack["ref"] == ref
            assert ack["status"] == "sent", \
                f"Expected 'sent' in car mode, got '{ack['status']}'"
            logger.info(f"Car mode ack OK: status={ack['status']}")
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_can_bus_send_called(self, car_ws_server):
        """Verifies the mock CAN bus .send() was actually invoked."""
        url, mock_bus = car_ws_server
        ws = WebSocketHelper(url)
        try:
            await ws.connect()
            await ws.send_message({
                "type": "can_send",
                "ref": "hw-check",
                "canId": 192,
                "data": [1, 2, 3, 4, 5, 6, 7, 8],
            })
            await ws.receive_message(timeout=5)
            mock_bus.send.assert_called_once()
            sent_msg = mock_bus.send.call_args[0][0]
            assert sent_msg.arbitration_id == 192
            assert sent_msg.data == bytes([1, 2, 3, 4, 5, 6, 7, 8])
            logger.info("CAN bus.send() called with correct message")
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_no_redis_publish(self, car_ws_server):
        """Car mode must NOT publish to Redis can_uplink channel."""
        url, _ = car_ws_server
        try:
            r = RedisHelper(host=REDIS_HOST, port=REDIS_PORT)
            r.subscribe("can_uplink")
        except Exception:
            pytest.skip("Redis not available — skipping Redis isolation check")
            return

        ws = WebSocketHelper(url)
        try:
            await ws.connect()
            ref = f"no-redis-{uuid.uuid4().hex[:6]}"
            await ws.send_message({
                "type": "can_send",
                "ref": ref,
                "canId": 256,
                "data": [0, 0, 50, 0, 0, 0, 0, 0],
            })
            await ws.receive_message(timeout=5)

            # Give Redis time to receive anything that might have been published
            await asyncio.sleep(0.5)
            redis_msg = r.get_message(timeout=1.0)
            assert redis_msg is None, \
                f"Car mode should NOT publish to Redis; got: {redis_msg}"
            logger.info("Redis isolation confirmed: no can_uplink publish in car mode")
        finally:
            await ws.close()
            r.close()

    @pytest.mark.asyncio
    async def test_can_write_failed_returns_error(self, car_ws_server):
        """If bus.send() raises, the server returns CAN_WRITE_FAILED."""
        url, mock_bus = car_ws_server
        mock_bus.send.side_effect = OSError("hardware fault")

        ws = WebSocketHelper(url)
        try:
            await ws.connect()
            await ws.send_message({
                "type": "can_send",
                "ref": "fail-ref",
                "canId": 256,
                "data": [0, 0, 0, 0, 0, 0, 0, 0],
            })
            resp = await ws.receive_message(timeout=5)
            assert resp is not None
            assert resp["type"] == "error"
            assert resp["code"] == "CAN_WRITE_FAILED"
            logger.info(f"CAN_WRITE_FAILED error OK: {resp['message']}")
        finally:
            await ws.close()


class TestCarModeCanSendBatch:
    """can_send_batch in car mode writes each frame and returns status="sent"."""

    @pytest.mark.asyncio
    async def test_batch_ack_status_is_sent(self, car_ws_server):
        url, _ = car_ws_server
        ws = WebSocketHelper(url)
        try:
            await ws.connect()
            ref = f"batch-car-{uuid.uuid4().hex[:6]}"
            await ws.send_message({
                "type": "can_send_batch",
                "ref": ref,
                "messages": [
                    {"canId": 192, "data": [1, 0, 0, 0, 0, 0, 0, 0]},
                    {"canId": 256, "data": [0, 0, 75, 0, 0, 0, 0, 0]},
                    {"canId": 512, "data": [0, 0, 0, 0, 100, 0, 0, 0]},
                ],
            })
            ack = await ws.receive_message(timeout=5)
            assert ack is not None
            assert ack["type"] == "uplink_ack"
            assert ack["ref"] == ref
            assert ack["status"] == "sent"
            logger.info("Car mode batch ack OK: status=sent")
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_batch_calls_send_per_message(self, car_ws_server):
        """bus.send() is called once for each message in the batch."""
        url, mock_bus = car_ws_server
        ws = WebSocketHelper(url)
        try:
            await ws.connect()
            await ws.send_message({
                "type": "can_send_batch",
                "ref": "cnt-check",
                "messages": [
                    {"canId": 192, "data": [1, 0, 0, 0, 0, 0, 0, 0]},
                    {"canId": 256, "data": [0, 0, 75, 0, 0, 0, 0, 0]},
                ],
            })
            await ws.receive_message(timeout=5)
            assert mock_bus.send.call_count == 2, \
                f"Expected 2 CAN sends, got {mock_bus.send.call_count}"
            logger.info("Correct send count for batch")
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_batch_mid_failure_returns_error(self, car_ws_server):
        """If bus.send() raises on the second message, CAN_WRITE_FAILED is returned."""
        url, mock_bus = car_ws_server
        # First send succeeds, second raises
        mock_bus.send.side_effect = [None, OSError("bus off")]

        ws = WebSocketHelper(url)
        try:
            await ws.connect()
            await ws.send_message({
                "type": "can_send_batch",
                "ref": "mid-fail",
                "messages": [
                    {"canId": 192, "data": [1, 0, 0, 0, 0, 0, 0, 0]},
                    {"canId": 256, "data": [0, 0, 75, 0, 0, 0, 0, 0]},
                ],
            })
            resp = await ws.receive_message(timeout=5)
            assert resp is not None
            assert resp["type"] == "error"
            assert resp["code"] == "CAN_WRITE_FAILED"
            assert "message 1" in resp["message"]
            logger.info(f"Mid-batch failure error OK: {resp['message']}")
        finally:
            await ws.close()


class TestCarModeUplinkDisabled:
    """ENABLE_UPLINK=false still blocks uplink in car mode."""

    @pytest.mark.asyncio
    async def test_uplink_disabled_returns_error(self, car_ws_server_uplink_disabled):
        url = car_ws_server_uplink_disabled
        ws = WebSocketHelper(url)
        try:
            await ws.connect()
            await ws.send_message({
                "type": "can_send",
                "ref": "blocked",
                "canId": 256,
                "data": [0, 0, 0, 0, 0, 0, 0, 0],
            })
            resp = await ws.receive_message(timeout=5)
            assert resp is not None
            assert resp["type"] == "error"
            assert resp["code"] == "UPLINK_DISABLED"
            logger.info("UPLINK_DISABLED correctly enforced in car mode")
        finally:
            await ws.close()


class TestCarModeErrorCodesUnchanged:
    """Validation errors behave identically in car mode vs base mode."""

    @pytest.mark.asyncio
    async def test_invalid_can_id_rejected(self, car_ws_server):
        url, _ = car_ws_server
        ws = WebSocketHelper(url)
        try:
            await ws.connect()
            await ws.send_message({
                "type": "can_send",
                "ref": "err-test",
                "canId": -1,
                "data": [0, 0, 0, 0],
            })
            resp = await ws.receive_message(timeout=5)
            assert resp["code"] == "INVALID_CAN_ID"
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_data_too_long_rejected(self, car_ws_server):
        url, _ = car_ws_server
        ws = WebSocketHelper(url)
        try:
            await ws.connect()
            await ws.send_message({
                "type": "can_send",
                "ref": "err-test",
                "canId": 256,
                "data": [0] * 9,
            })
            resp = await ws.receive_message(timeout=5)
            assert resp["code"] == "INVALID_DATA"
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_hex_string_data_rejected(self, car_ws_server):
        """Hex strings are not valid data — must be integer arrays."""
        url, _ = car_ws_server
        ws = WebSocketHelper(url)
        try:
            await ws.connect()
            await ws.send_message({
                "type": "can_send",
                "ref": "hex-test",
                "canId": 256,
                "data": ["0A", "1B", "2C", "3D", "00", "00", "00", "00"],
            })
            resp = await ws.receive_message(timeout=5)
            assert resp["type"] == "error"
            assert resp["code"] == "INVALID_DATA", \
                "Hex string elements must be rejected as INVALID_DATA"
            logger.info("Hex string data correctly rejected")
        finally:
            await ws.close()


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
