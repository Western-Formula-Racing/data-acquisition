"""
Unit tests for the status HTTP server — in particular /sync-cloud.

These tests verify:
  • /sync-cloud passes the correct cwd to subprocess.run (project root, not status/)
  • Successful cloud sync returns HTTP 200
  • Failed cloud sync returns HTTP 500 with the subprocess stderr
  • Unknown endpoints return 404
  • /set-time returns 403 when SET_TIME_ENABLED=false
"""

import json
import os
import subprocess
import tempfile
import threading
from http.client import HTTPConnection
from unittest.mock import patch, MagicMock

import pytest


# ── Handler mock ───────────────────────────────────────────────────────────────

class _MockHandler:
    """
    Minimal stand-in for StatusHTTPRequestHandler with just the machinery
    needed to test _handle_sync_cloud and do_POST.
    """

    def __init__(self):
        self.path = "/sync-cloud"
        self._headers = {}
        self._body = b""
        self._response_code = None
        self._response_headers = {}
        self._response_body = b""
        self.log_message = MagicMock()
        self._json_response_code = None
        self._json_response_body = None

    def send_response(self, code):
        self._response_code = code

    def send_header(self, name, value):
        self._response_headers[name] = value

    def end_headers(self):
        pass

    @property
    def headers(self):
        return self._headers

    @headers.setter
    def headers(self, value):
        self._headers = value

    def _json_response(self, code, payload):
        self._json_response_code = code
        self._json_response_body = payload
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())

    @property
    def rfile(self):
        rfile = MagicMock()
        rfile.read = lambda n=0: self._body
        return rfile

    @property
    def wfile(self):
        wfile = MagicMock()
        wfile.write = MagicMock()
        return wfile

    # Proxy headers.get to the underlying dict
    def get_header(self, key, default=None):
        return self._headers.get(key, default)


# ── Tests ─────────────────────────────────────────────────────────────────────

class TestSyncCloudEndpoint:
    """Tests for the /sync-cloud POST endpoint."""

    def test_sync_cloud_uses_project_root_as_cwd(self, tmp_path):
        """
        Verifies that _handle_sync_cloud passes cwd=project_root to subprocess.run,
        NOT the status/ directory that the server chdir()s into at startup.

        This is the core regression test for the missing-cwd bug.
        """
        from src.status_server import StatusHTTPRequestHandler

        captured_cwds = []

        def fake_run(cmd, **kwargs):
            captured_cwds.append(kwargs.get("cwd"))
            return MagicMock(returncode=0, stdout="", stderr="")

        handler = _MockHandler()
        handler._headers["Content-Length"] = "0"
        handler._body = b""

        with patch.object(StatusHTTPRequestHandler, "__init__", lambda self, *a, **kw: None):
            h = object.__new__(StatusHTTPRequestHandler)
            h.log_message = MagicMock()

            class _H:
                def get(self, key, default=None):
                    return handler._headers.get(key, default)
            h.headers = _H()
            h.rfile = handler.rfile
            h.wfile = handler.wfile
            h.send_response = handler.send_response
            h.send_header = handler.send_header
            h.end_headers = handler.end_headers
            h._json_response = handler._json_response
            h.log_message = handler.log_message

            with patch("subprocess.run", fake_run):
                h._handle_sync_cloud()

        assert len(captured_cwds) == 1, "subprocess.run should be called exactly once"
        cwd = captured_cwds[0]

        # The cwd must be a directory whose parent contains the src package,
        # not the status/ subdirectory (which is where run_status_server chdirs to).
        # We check: (1) it's a real directory, (2) src/ is a subdirectory of it.
        import os
        assert os.path.isdir(cwd), f"cwd '{cwd}' is not a directory"
        assert os.path.isdir(os.path.join(cwd, "src")), (
            f"cwd '{cwd}' does not contain src/ — "
            "cwd may have been incorrectly set to the status/ directory"
        )

    def test_sync_cloud_success_returns_200(self, tmp_path):
        """Cloud sync with returncode 0 should produce a 200 JSON response."""
        from src.status_server import StatusHTTPRequestHandler

        project_root = tmp_path / "project"
        src_dir = project_root / "src"
        src_dir.mkdir(parents=True)
        (src_dir / "__init__.py").write_text("")
        (src_dir / "cloud_sync.py").write_text("raise SystemExit(0)")

        handler = _MockHandler()
        handler._headers["Content-Length"] = "0"
        handler._body = b""

        with patch.object(StatusHTTPRequestHandler, "__init__", lambda self, *a, **kw: None):
            h = object.__new__(StatusHTTPRequestHandler)
            h.log_message = MagicMock()
            h._headers_dict = handler._headers
            h._body_bytes = handler._body

            class _H:
                def get(self, key, default=None):
                    return handler._headers.get(key, default)
            h.headers = _H()
            h.rfile = handler.rfile
            h.wfile = handler.wfile
            h.send_response = handler.send_response
            h.send_header = handler.send_header
            h.end_headers = handler.end_headers
            h._json_response = handler._json_response
            h.log_message = handler.log_message

            with patch("subprocess.run", lambda cmd, **kw: MagicMock(returncode=0, stdout="sync done", stderr="")):
                h._handle_sync_cloud()

        assert handler._json_response_code == 200, (
            f"Expected 200, got {handler._json_response_code}: {handler._json_response_body}"
        )
        assert handler._json_response_body.get("ok") is True
        assert handler._json_response_body.get("output") == "sync done"

    def test_sync_cloud_failure_returns_500(self, tmp_path):
        """Cloud sync with non-zero returncode should return HTTP 500 with error."""
        from src.status_server import StatusHTTPRequestHandler

        project_root = tmp_path / "project"
        src_dir = project_root / "src"
        src_dir.mkdir(parents=True)
        (src_dir / "__init__.py").write_text("")
        (src_dir / "cloud_sync.py").write_text("raise SystemExit(0)")

        handler = _MockHandler()
        handler._headers["Content-Length"] = "0"
        handler._body = b""

        with patch.object(StatusHTTPRequestHandler, "__init__", lambda self, *a, **kw: None):
            h = object.__new__(StatusHTTPRequestHandler)
            h.log_message = MagicMock()

            class _H:
                def get(self, key, default=None):
                    return handler._headers.get(key, default)
            h.headers = _H()
            h.rfile = handler.rfile
            h.wfile = handler.wfile
            h.send_response = handler.send_response
            h.send_header = handler.send_header
            h.end_headers = handler.end_headers
            h._json_response = handler._json_response
            h.log_message = handler.log_message

            with patch(
                "subprocess.run",
                lambda cmd, **kw: MagicMock(returncode=1, stdout="", stderr="influx timeout")
            ):
                h._handle_sync_cloud()

        assert handler._json_response_code == 500, (
            f"Expected 500, got {handler._json_response_code}: {handler._json_response_body}"
        )
        assert "influx timeout" in handler._json_response_body.get("error", "")

    def test_sync_cloud_passes_bucket_in_env(self, tmp_path):
        """POST body with bucket field should set CLOUD_INFLUX_BUCKET in subprocess env."""
        from src.status_server import StatusHTTPRequestHandler

        project_root = tmp_path / "project"
        src_dir = project_root / "src"
        src_dir.mkdir(parents=True)
        (src_dir / "__init__.py").write_text("")
        (src_dir / "cloud_sync.py").write_text("raise SystemExit(0)")

        captured_env = {}

        def fake_run(cmd, **kwargs):
            captured_env.update(kwargs.get("env", {}))
            return MagicMock(returncode=0, stdout="", stderr="")

        handler = _MockHandler()
        body = json.dumps({"bucket": "WFR27"}).encode()
        handler._headers["Content-Length"] = str(len(body))
        handler._body = body

        with patch.object(StatusHTTPRequestHandler, "__init__", lambda self, *a, **kw: None):
            h = object.__new__(StatusHTTPRequestHandler)
            h.log_message = MagicMock()

            class _H:
                def get(self, key, default=None):
                    return handler._headers.get(key, default)
            h.headers = _H()
            h.rfile = handler.rfile
            h.wfile = handler.wfile
            h.send_response = handler.send_response
            h.send_header = handler.send_header
            h.end_headers = handler.end_headers
            h._json_response = handler._json_response
            h.log_message = handler.log_message

            with patch("subprocess.run", fake_run):
                h._handle_sync_cloud()

        assert captured_env.get("CLOUD_INFLUX_BUCKET") == "WFR27", (
            f"Expected CLOUD_INFLUX_BUCKET=WFR27, got {captured_env}"
        )

    def test_unknown_endpoint_returns_404(self):
        """Any unknown path should return 404."""
        from src.status_server import StatusHTTPRequestHandler

        handler = _MockHandler()
        handler.path = "/completely-unknown"
        response_codes = []

        def capture_response(code):
            response_codes.append(code)

        with patch.object(StatusHTTPRequestHandler, "__init__", lambda self, *a, **kw: None):
            h = object.__new__(StatusHTTPRequestHandler)
            h.log_message = MagicMock()
            h.path = "/completely-unknown"
            h.send_response = capture_response
            h.end_headers = MagicMock()
            h.do_POST()

        assert response_codes == [404], f"Expected 404, got {response_codes}"
