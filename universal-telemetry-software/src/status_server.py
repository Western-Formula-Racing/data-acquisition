#!/usr/bin/env python3
"""
Simple HTTP server to serve the status monitoring page.
Runs on port 8080 and serves static files from the status/ directory.

Extra endpoints:
  POST /set-time   {"time": "2026-03-22T14:35:00"}
      Sets the RPi system clock via `date -s`.
      Works because the telemetry container runs with privileged: true,
      which allows setting the host kernel clock from inside the container.
"""
import http.server
import socketserver
import os
import json
import subprocess
import logging

logger = logging.getLogger("StatusServer")

PORT = int(os.getenv("STATUS_PORT", 8080))
TOKEN_FILE = "/app/relay_token"


def _read_relay_token() -> str:
    try:
        with open(TOKEN_FILE) as f:
            return f.read().strip()
    except FileNotFoundError:
        pass
    return os.getenv("RELAY_TOKEN", "")
DIRECTORY = os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + "/status"
# SET_TIME_ENABLED must be explicitly set to "true" to allow the /set-time endpoint.
# This prevents unauthenticated callers from modifying the host clock.
SET_TIME_ENABLED = os.getenv("SET_TIME_ENABLED", "false").lower() == "true"


class StatusTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


class StatusHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def log_message(self, format, *args):
        logger.info("%s - - [%s] %s" % (self.address_string(), self.log_date_time_string(), format % args))

    def do_GET(self):
        if self.path == '/relay-info':
            token = _read_relay_token()
            port = int(os.getenv("RELAY_LISTEN_PORT", "9089"))
            self._json_response(200, {"token": token, "port": port, "enabled": True})
            return
        super().do_GET()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        if self.path == '/relay-token':
            self._handle_relay_token()
            return
        if self.path == '/set-time':
            if not SET_TIME_ENABLED:
                self._json_response(403, {"error": "set-time is disabled (set SET_TIME_ENABLED=true)"})
                return
            self._handle_set_time()
        else:
            self.send_response(404)
            self.end_headers()

    def _handle_set_time(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length))
            time_str = body.get('time', '').strip()
            if not time_str:
                self._json_response(400, {"error": "Missing 'time' field"})
                return

            # `date -s` accepts ISO 8601 and many other formats.
            # The container must run with privileged: true for this to affect the host clock.
            result = subprocess.run(
                ["date", "-s", time_str],
                capture_output=True, text=True, timeout=5
            )
            if result.returncode != 0:
                logger.error(f"date -s failed: {result.stderr}")
                self._json_response(500, {"error": result.stderr.strip()})
                return

            new_time = result.stdout.strip()
            logger.info(f"System clock set to: {new_time}")
            self._json_response(200, {"ok": True, "time": new_time})

        except Exception as e:
            logger.error(f"/set-time error: {e}")
            self._json_response(500, {"error": str(e)})

    def _handle_relay_token(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length))
            token = body.get('token', '').strip()
            with open(TOKEN_FILE, 'w') as f:
                f.write(token)
            logger.info("Relay token updated via UI")
            self._json_response(200, {"ok": True, "token": token})
        except Exception as e:
            logger.error(f"/relay-token error: {e}")
            self._json_response(500, {"error": str(e)})

    def _json_response(self, code: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def run_status_server():
    """Main entry point for status HTTP server."""
    os.chdir(DIRECTORY)
    with StatusTCPServer(("0.0.0.0", PORT), StatusHTTPRequestHandler) as httpd:
        logger.info(f"Serving status page at http://0.0.0.0:{PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            logger.info("Shutting down status server...")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    run_status_server()
