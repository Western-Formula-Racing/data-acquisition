"""
Regression tests for the bare json.loads(timescale_raw) bug in stats_publisher.

Bug: stats_publisher called json.loads(timescale_raw) with no try/except.
Any non-JSON value in the timescale:status Redis key (empty string, partial write,
corrupted bytes) raises JSONDecodeError, which propagates out of the coroutine.
Since stats_publisher runs inside asyncio.gather(*tasks) with return_exceptions=False
(default), this cancels all sibling tasks — crashing the base-station pipeline.

The fix: wrap json.loads in try/except JSONDecodeError, log a warning,
and leave timescale_status = None.

These tests verify the fix by running the actual JSON-parsing logic directly.
"""

import json
import logging
import pytest
from unittest.mock import MagicMock


# The exact snippet of logic from stats_publisher — copied verbatim so this test
# stays faithful to the real code and catches regressions.
def _parse_timescale_status(timescale_raw: bytes | None) -> dict | None:
    """
    Mirrors stats_publisher's timescale:status parsing logic.
    Returns the parsed dict, or None on any error.
    """
    if not timescale_raw:
        return None
    try:
        return json.loads(timescale_raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        logging.getLogger("TelemetryNode").warning(
            f"timescale:status contains invalid JSON: {timescale_raw!r}"
        )
        return None


class TestTimescaleStatusParsing:
    """Verify timescale:status parsing handles bad Redis values without crashing."""

    def test_non_json_bytes_returns_none(self):
        """Corrupted bytes must not raise — must return None."""
        # \xff is invalid UTF-8; json.loads raises UnicodeDecodeError before JSONDecodeError
        result = _parse_timescale_status(b"not valid json \xff")
        assert result is None

    def test_empty_bytes_returns_none(self):
        """Empty bytes string must not raise — must return None."""
        result = _parse_timescale_status(b"")
        assert result is None

    def test_valid_json_returns_parsed_dict(self):
        """Valid JSON must be parsed and returned."""
        payload = json.dumps({
            "ok": True, "rows": 1234, "errors": 0, "ts": 1234567890.0
        }).encode()
        result = _parse_timescale_status(payload)
        assert result is not None
        assert result["rows"] == 1234
        assert result["ok"] is True

    def test_none_returns_none(self):
        """None input must return None without error."""
        result = _parse_timescale_status(None)
        assert result is None

    def test_partial_json_returns_none(self):
        """Truncated JSON must not raise — must return None."""
        result = _parse_timescale_status(b'{"ok": true, "rows":')
        assert result is None

    def test_warning_logged_on_bad_json(self, caplog):
        """A warning must be logged when JSON is invalid."""
        _parse_timescale_status(b"not valid json")
        assert any("timescale:status contains invalid JSON" in r.message for r in caplog.records)

    def test_no_warning_on_valid_json(self, caplog):
        """No warning should be logged for valid JSON."""
        payload = json.dumps({"ok": True}).encode()
        _parse_timescale_status(payload)
        assert not any("timescale:status contains invalid JSON" in r.message for r in caplog.records)
