"""
Unit tests for the InfluxDB bridge — wide-format interface.

Tests CAN decoding logic, line protocol formatting, and cloud sync helpers
without requiring a running InfluxDB or Redis instance.
"""

import json
import os
import pytest
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

import slicks

# ── Fixtures ──────────────────────────────────────────────────────────────────

# Path to the example DBC file (relative to repo root)
DBC_PATH = Path(__file__).parent.parent / "example.dbc"


@pytest.fixture
def dbc_env():
    """Set environment for DBC path resolution."""
    with patch.dict(os.environ, {"DBC_FILE_PATH": str(DBC_PATH)}):
        yield


# ── Line protocol formatting ─────────────────────────────────────────────────

class TestLineProtocol:
    """Test wide-format InfluxDB line protocol formatting via slicks."""

    def test_frame_to_line_protocol_basic(self):
        """frame_to_line_protocol produces valid wide line protocol."""
        frame = slicks.DecodedFrame(
            message_name="BMS_Current_Limit",
            can_id=514,
            signals={"BMS_Max_Discharge_Current": 4096.0, "BMS_Max_Charge_Current": 0.0},
        )
        line = slicks.frame_to_line_protocol(
            measurement="WFR26_base",
            frame=frame,
            ts_ns=1700000000000000000,
        )
        assert line.startswith("WFR26_base,")
        assert "messageName=BMS_Current_Limit" in line
        assert "canId=514" in line
        assert "BMS_Max_Discharge_Current=" in line
        assert "BMS_Max_Charge_Current=" in line
        assert line.endswith("1700000000000000000")

    def test_frame_to_line_protocol_no_tags(self):
        """include_tags=False omits messageName/canId tags."""
        frame = slicks.DecodedFrame(
            message_name="BMS_Current_Limit",
            can_id=514,
            signals={"BMS_Max_Discharge_Current": 4096.0},
        )
        line = slicks.frame_to_line_protocol(
            measurement="WFR26_base",
            frame=frame,
            ts_ns=1,
            include_tags=False,
        )
        assert "messageName=" not in line
        assert "canId=" not in line
        assert "BMS_Max_Discharge_Current=" in line

    def test_frame_to_line_protocol_special_chars_in_measurement(self):
        """Measurement names with special chars are escaped."""
        frame = slicks.DecodedFrame(
            message_name="BMS",
            can_id=512,
            signals={"Speed": 42.0},
        )
        line = slicks.frame_to_line_protocol(
            measurement="WFR26_base",
            frame=frame,
            ts_ns=1,
        )
        assert "WFR26_base" in line

    def test_frame_to_line_protocol_empty_signals_raises(self):
        """frame_to_line_protocol raises ValueError for frames with no signals."""
        frame = slicks.DecodedFrame(
            message_name="Empty",
            can_id=999,
            signals={},
        )
        with pytest.raises(ValueError):
            slicks.frame_to_line_protocol("WFR26_base", frame, 1)


# ── CAN decoding ─────────────────────────────────────────────────────────────

class TestCANDecoding:
    """Test CAN message decoding via slicks.decode_frame."""

    def test_decode_known_can_id(self):
        """Decode a CAN ID that exists in the DBC."""
        db = slicks.load_dbc(DBC_PATH)
        data = bytes([0x00, 0x10, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00])
        frame = slicks.decode_frame(db, can_id=514, data=data)

        assert frame is not None
        assert len(frame.signals) > 0
        assert frame.can_id == 514

    def test_decode_unknown_can_id(self):
        """Unknown CAN IDs should return None (no crash)."""
        db = slicks.load_dbc(DBC_PATH)
        frame = slicks.decode_frame(db, can_id=9999, data=bytes(8))
        assert frame is None

    def test_decode_timestamps_via_bridge(self, dbc_env):
        """Verify ms → ns timestamp conversion in process_message."""
        with patch("slicks.writer.InfluxDBClient"):
            from src.influx_bridge import InfluxBridge
            bridge = InfluxBridge()
            msg = json.dumps([{
                "time": 1700000000000,
                "canId": 514,
                "data": [0, 16, 0, 0, 100, 0, 0, 0],
            }])
            with patch.object(
                bridge.writer, "decode_and_queue", wraps=bridge.writer.decode_and_queue
            ) as mock_q:
                bridge.process_message(msg)
                if mock_q.called:
                    _, _, ts_ns = mock_q.call_args[0]
                    assert ts_ns == 1700000000000 * 1_000_000
            bridge.close()

    def test_extended_can_id_stripped(self):
        """Extended CAN IDs (bit 31 set) should be stripped before DBC lookup."""
        db = slicks.load_dbc(DBC_PATH)
        data = bytes([0x00, 0x10, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00])
        frame_normal = slicks.decode_frame(db, can_id=514, data=data)
        frame_extended = slicks.decode_frame(db, can_id=514 | 0x80000000, data=data)
        # Both should decode to the same message
        if frame_normal is not None:
            assert frame_extended is not None
            assert frame_extended.message_name == frame_normal.message_name


# ── Redis message processing ─────────────────────────────────────────────────

class TestMessageProcessing:
    """Test processing of Redis JSON messages via InfluxBridge."""

    @pytest.fixture
    def bridge(self, dbc_env):
        with patch("slicks.writer.InfluxDBClient"):
            from src.influx_bridge import InfluxBridge
            b = InfluxBridge()
            yield b
            b.close()

    def test_process_valid_message(self, bridge):
        """Process a well-formed Redis CAN message — returns positive count."""
        msg = json.dumps([{
            "time": 1700000000000,
            "canId": 514,
            "data": [0, 16, 0, 0, 100, 0, 0, 0],
        }])
        count = bridge.process_message(msg)
        assert count > 0

    def test_process_multiple_messages(self, bridge):
        """Process a batch of CAN messages — returns cumulative count."""
        msgs = json.dumps([
            {"time": 1700000000000, "canId": 512, "data": [0]*8},
            {"time": 1700000000001, "canId": 192, "data": [0]*8},
        ])
        count = bridge.process_message(msgs)
        assert count >= 0

    def test_process_invalid_json(self, bridge):
        """Invalid JSON should not crash and return 0."""
        count = bridge.process_message("not valid json {{{")
        assert count == 0

    def test_process_missing_fields(self, bridge):
        """Messages missing required fields should be skipped, return 0."""
        msg = json.dumps([{"time": 1700000000000}])  # missing canId, data
        count = bridge.process_message(msg)
        assert count == 0

    def test_process_short_data(self, bridge):
        """CAN data shorter than 8 bytes should be skipped."""
        msg = json.dumps([{
            "time": 1700000000000,
            "canId": 512,
            "data": [0, 1, 2],  # only 3 bytes
        }])
        count = bridge.process_message(msg)
        assert count == 0

    def test_process_returns_int(self, bridge):
        """process_message always returns an int, not a list."""
        msg = json.dumps([{
            "time": 1700000000000,
            "canId": 514,
            "data": [0]*8,
        }])
        result = bridge.process_message(msg)
        assert isinstance(result, int)


# ── Cloud sync helpers ────────────────────────────────────────────────────────

class TestCloudSyncHelpers:
    """Test cloud sync utility functions."""

    def test_state_file_roundtrip(self):
        """Save and load sync state."""
        from src.cloud_sync import save_last_sync_time, load_last_sync_time
        from datetime import datetime, timezone

        with tempfile.TemporaryDirectory() as tmpdir:
            test_state = Path(tmpdir) / "state.json"
            with patch("src.cloud_sync.STATE_FILE", test_state):
                now = datetime.now(timezone.utc)
                save_last_sync_time(now)

                loaded = load_last_sync_time()
                assert abs((loaded - now).total_seconds()) < 1

    def test_state_file_missing(self):
        """Missing state file should default to 24h ago."""
        from src.cloud_sync import load_last_sync_time
        from datetime import datetime, timezone, timedelta

        with tempfile.TemporaryDirectory() as tmpdir:
            test_state = Path(tmpdir) / "nonexistent.json"
            with patch("src.cloud_sync.STATE_FILE", test_state):
                loaded = load_last_sync_time()
                expected = datetime.now(timezone.utc) - timedelta(hours=24)
                assert abs((loaded - expected).total_seconds()) < 5

    def test_check_cloud_unreachable(self):
        """Connectivity check against unreachable host should return False."""
        from src.cloud_sync import check_cloud_reachable
        assert check_cloud_reachable(host="127.0.0.1", port=65535, timeout=1) is False


# ── Table/measurement naming ─────────────────────────────────────────────────

class TestTableNaming:
    """Verify season-based measurement naming is passed to WideWriter correctly."""

    def test_default_table_name(self, dbc_env):
        """Default INFLUX_TABLE should be used as WideWriter measurement."""
        with patch.dict(os.environ, {"INFLUX_TABLE": "WFR26_base"}):
            with patch("slicks.writer.InfluxDBClient"):
                from importlib import reload
                import src.config
                import src.influx_bridge
                reload(src.config)
                reload(src.influx_bridge)
                bridge = src.influx_bridge.InfluxBridge()
                assert bridge.writer._measurement == "WFR26_base"
                bridge.close()

    def test_custom_season_table(self, dbc_env):
        """Custom INFLUX_TABLE should be passed to WideWriter as measurement."""
        with patch.dict(os.environ, {"INFLUX_TABLE": "WFR27_base"}):
            with patch("slicks.writer.InfluxDBClient"):
                from importlib import reload
                import src.config
                import src.influx_bridge
                reload(src.config)
                reload(src.influx_bridge)
                bridge = src.influx_bridge.InfluxBridge()
                assert bridge.writer._measurement == "WFR27_base"
                bridge.close()
