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
