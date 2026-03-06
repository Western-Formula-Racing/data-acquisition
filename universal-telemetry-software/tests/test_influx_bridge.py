"""
Unit tests for the InfluxDB bridge and cloud sync modules.

Tests CAN decoding logic, line protocol formatting, and cloud sync helpers
without requiring a running InfluxDB or Redis instance.
"""

import json
import os
import pytest
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

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
    """Test InfluxDB line protocol formatting helpers."""

    def test_escape_tag(self):
        from src.influx_bridge import _escape_tag
        assert _escape_tag("hello world") == r"hello\ world"
        assert _escape_tag("a,b") == r"a\,b"
        assert _escape_tag("a=b") == r"a\=b"
        assert _escape_tag("normal") == "normal"

    def test_format_line_protocol(self):
        from src.influx_bridge import _to_line_protocol

        line = _to_line_protocol(
            measurement="WFR26_base",
            tags={"signalName": "RPM", "canId": "256"},
            fields={"sensorReading": 3500.0},
            ts_ns=1700000000000000000,
        )
        assert line.startswith("WFR26_base,")
        assert "signalName=RPM" in line
        assert "canId=256" in line
        assert "sensorReading=3500.0" in line
        assert line.endswith("1700000000000000000")

    def test_format_with_special_chars(self):
        from src.influx_bridge import _to_line_protocol

        line = _to_line_protocol(
            measurement="WFR26_base",
            tags={"signalName": "Motor RPM"},
            fields={"sensorReading": 42.0},
            ts_ns=1,
        )
        # Space in tag value should be escaped
        assert r"signalName=Motor\ RPM" in line


# ── CAN decoding ─────────────────────────────────────────────────────────────

class TestCANDecoding:
    """Test CAN message decoding via DBC."""

    @pytest.fixture
    def bridge(self, dbc_env):
        """Create an InfluxBridge with mocked InfluxDB client."""
        with patch("src.influx_bridge.InfluxDBClient"):
            from src.influx_bridge import InfluxBridge
            b = InfluxBridge()
            yield b
            b.close()

    def test_decode_known_can_id(self, bridge):
        """Decode a CAN ID that exists in the DBC."""
        # CAN ID 512 = BMS_Status in example.dbc
        # Pack some reasonable bytes
        data = bytes([0x00, 0x10, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00])
        lines = bridge.decode_can(can_id=512, data=data, ts_ms=1700000000000)

        assert len(lines) > 0, "Should decode at least one signal"
        # Each line should be valid line protocol
        for line in lines:
            assert "WFR26_base," in line or line.startswith("WFR26_base,")
            assert "signalName=" in line
            assert "sensorReading=" in line

    def test_decode_unknown_can_id(self, bridge):
        """Unknown CAN IDs should return empty list (no crash)."""
        lines = bridge.decode_can(can_id=9999, data=bytes(8), ts_ms=1700000000000)
        assert lines == []

    def test_decode_timestamps(self, bridge):
        """Verify ms → ns timestamp conversion."""
        data = bytes(8)
        # Use CAN ID 192 (VCU_Status) which should exist
        lines = bridge.decode_can(can_id=192, data=data, ts_ms=1700000000000)
        if lines:
            # Timestamp should be in nanoseconds
            ts_str = lines[0].split()[-1]
            assert ts_str == "1700000000000000000"


# ── Redis message processing ─────────────────────────────────────────────────

class TestMessageProcessing:
    """Test processing of Redis JSON messages."""

    @pytest.fixture
    def bridge(self, dbc_env):
        with patch("src.influx_bridge.InfluxDBClient"):
            from src.influx_bridge import InfluxBridge
            b = InfluxBridge()
            yield b
            b.close()

    def test_process_valid_message(self, bridge):
        """Process a well-formed Redis CAN message."""
        msg = json.dumps([{
            "time": 1700000000000,
            "canId": 512,
            "data": [0, 16, 0, 0, 100, 0, 0, 0],
        }])
        lines = bridge.process_message(msg)
        assert len(lines) > 0

    def test_process_multiple_messages(self, bridge):
        """Process a batch of CAN messages."""
        msgs = json.dumps([
            {"time": 1700000000000, "canId": 512, "data": [0]*8},
            {"time": 1700000000001, "canId": 192, "data": [0]*8},
        ])
        lines = bridge.process_message(msgs)
        assert len(lines) > 0

    def test_process_invalid_json(self, bridge):
        """Invalid JSON should not crash."""
        lines = bridge.process_message("not valid json {{{")
        assert lines == []

    def test_process_missing_fields(self, bridge):
        """Messages missing required fields should be skipped."""
        msg = json.dumps([{"time": 1700000000000}])  # missing canId, data
        lines = bridge.process_message(msg)
        assert lines == []

    def test_process_short_data(self, bridge):
        """CAN data shorter than 8 bytes should be skipped."""
        msg = json.dumps([{
            "time": 1700000000000,
            "canId": 512,
            "data": [0, 1, 2],  # only 3 bytes
        }])
        lines = bridge.process_message(msg)
        assert lines == []


# ── Cloud sync helpers ────────────────────────────────────────────────────────

class TestCloudSyncHelpers:
    """Test cloud sync utility functions."""

    def test_state_file_roundtrip(self):
        """Save and load sync state."""
        from src.cloud_sync import save_last_sync_time, load_last_sync_time, STATE_FILE
        from datetime import datetime, timezone

        with tempfile.TemporaryDirectory() as tmpdir:
            test_state = Path(tmpdir) / "state.json"
            with patch("src.cloud_sync.STATE_FILE", test_state):
                now = datetime.now(timezone.utc)
                save_last_sync_time(now)

                loaded = load_last_sync_time()
                # Should be very close (within 1 second due to serialization)
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
        # Use localhost with an unreachable port to guarantee connection refused
        assert check_cloud_reachable(host="127.0.0.1", port=65535, timeout=1) is False


# ── Table/measurement naming ─────────────────────────────────────────────────

class TestTableNaming:
    """Verify season-based table naming works correctly."""

    def test_default_table_name(self, dbc_env):
        """Default INFLUX_TABLE should be WFR26_base."""
        with patch.dict(os.environ, {"INFLUX_TABLE": "WFR26_base"}):
            with patch("src.influx_bridge.InfluxDBClient"):
                from importlib import reload
                import src.influx_bridge
                reload(src.influx_bridge)
                bridge = src.influx_bridge.InfluxBridge()
                lines = bridge.decode_can(512, bytes(8), 1700000000000)
                if lines:
                    assert "WFR26_base," in lines[0]
                bridge.close()

    def test_custom_season_table(self, dbc_env):
        """Custom INFLUX_TABLE should be used in line protocol."""
        with patch.dict(os.environ, {"INFLUX_TABLE": "WFR27_base"}):
            with patch("src.influx_bridge.InfluxDBClient"):
                from importlib import reload
                import src.influx_bridge
                reload(src.influx_bridge)
                bridge = src.influx_bridge.InfluxBridge()
                lines = bridge.decode_can(512, bytes(8), 1700000000000)
                if lines:
                    assert "WFR27_base," in lines[0]
                bridge.close()
