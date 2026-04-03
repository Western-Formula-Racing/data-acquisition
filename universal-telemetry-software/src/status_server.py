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
import urllib.request
import urllib.error

logger = logging.getLogger("StatusServer")

PORT = int(os.getenv("STATUS_PORT", 8080))
DIRECTORY = os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + "/status"
# SET_TIME_ENABLED must be explicitly set to "true" to allow the /set-time endpoint.
# This prevents unauthenticated callers from modifying the host clock.
SET_TIME_ENABLED  = os.getenv("SET_TIME_ENABLED",  "false").lower() == "true"
SHUTDOWN_ENABLED  = os.getenv("SHUTDOWN_ENABLED",  "false").lower() == "true"
REMOTE_IP         = os.getenv("REMOTE_IP", "")
REMOTE_STATUS_PORT = int(os.getenv("STATUS_PORT", 8080))


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

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        if self.path == '/set-time':
            if not SET_TIME_ENABLED:
                self._json_response(403, {"error": "set-time is disabled (set SET_TIME_ENABLED=true)"})
                return
            self._handle_set_time()
        elif self.path == '/shutdown':
            if not SHUTDOWN_ENABLED:
                self._json_response(403, {"error": "shutdown is disabled (set SHUTDOWN_ENABLED=true)"})
                return
            self._handle_shutdown()
        elif self.path == '/shutdown-car':
            self._handle_shutdown_car()
        elif self.path == '/inject-car-time':
            self._handle_inject_car_time()
        elif self.path == '/sync-cloud':
            self._handle_sync_cloud()
        else:
            self.send_response(404)
            self.end_headers()

    def _handle_sync_cloud(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            bucket = "WFR26"
            if length > 0:
                body = json.loads(self.rfile.read(length))
                bucket = body.get('bucket', 'WFR26').strip() or "WFR26"
                
            logger.info(f"Manual cloud sync triggered via API (bucket={bucket})")
            
            env = os.environ.copy()
            env["CLOUD_INFLUX_BUCKET"] = bucket
            
            # Run the cloud sync manually and capture output
            # cwd must be the project root so python -m src.cloud_sync resolves correctly
            project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            result = subprocess.run(
                ["python", "-m", "src.cloud_sync"],
                capture_output=True, text=True, timeout=120, cwd=project_root, env=env
            )
            if result.returncode != 0:
                logger.error(f"Cloud sync failed: {result.stderr}")
                self._json_response(500, {"error": result.stderr.strip() or result.stdout.strip()})
                return
            
            logger.info(f"Cloud sync completed successfully")
            self._json_response(200, {"ok": True, "output": result.stdout.strip()})
        except Exception as e:
            logger.error(f"/sync-cloud error: {e}")
            self._json_response(500, {"error": str(e)})

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

    def _handle_inject_car_time(self):
        if not REMOTE_IP:
            self._json_response(500, {"error": "REMOTE_IP not configured"})
            return
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            time_str = body.get('time', '').strip()
            if not time_str:
                self._json_response(400, {"error": "Missing 'time' field"})
                return
            url = f"http://{REMOTE_IP}:{REMOTE_STATUS_PORT}/set-time"
            payload = json.dumps({"time": time_str}).encode()
            req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
            resp = urllib.request.urlopen(req, timeout=5)
            result = json.loads(resp.read().decode())
            logger.info(f"Car Pi clock set to {time_str} via manual injection")
            self._json_response(200, {"ok": True, "time": result.get("time", time_str)})
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            logger.warning(f"Car rejected time injection ({e.code}): {body}")
            self._json_response(e.code, {"error": body})
        except urllib.error.URLError as e:
            logger.warning(f"Car unreachable for time injection: {e.reason}")
            self._json_response(503, {"error": f"Car unreachable — is it on? ({e.reason})"})
        except Exception as e:
            logger.error(f"/inject-car-time error: {e}")
            self._json_response(500, {"error": str(e)})

    def _handle_shutdown(self):
        logger.warning("Shutdown requested via /shutdown — halting system now")
        self._json_response(200, {"ok": True, "message": "Shutting down..."})
        subprocess.Popen(["shutdown", "-h", "now"])

    def _handle_shutdown_car(self):
        if not REMOTE_IP:
            self._json_response(500, {"error": "REMOTE_IP not configured"})
            return
        url = f"http://{REMOTE_IP}:{REMOTE_STATUS_PORT}/shutdown"
        try:
            req = urllib.request.Request(url, data=b"", method="POST")
            urllib.request.urlopen(req, timeout=5)
            logger.info(f"Shutdown command sent to car at {url}")
            self._json_response(200, {"ok": True, "message": f"Shutdown sent to {REMOTE_IP}"})
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            logger.warning(f"Car shutdown rejected ({e.code}): {body}")
            self._json_response(e.code, {"error": body})
        except urllib.error.URLError as e:
            logger.warning(f"Car unreachable for shutdown ({url}): {e.reason}")
            self._json_response(503, {"error": f"Car unreachable: {e.reason}"})
        except Exception as e:
            logger.error(f"/shutdown-car error: {e}")
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
