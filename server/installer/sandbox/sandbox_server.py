from __future__ import annotations

import base64
import json
import os
import subprocess
import tempfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List

SANDBOX_PORT = int(os.getenv("SANDBOX_PORT", "8080"))
SANDBOX_TIMEOUT = int(os.getenv("SANDBOX_TIMEOUT", "120"))
SANDBOX_MAX_FILE_MB = int(os.getenv("SANDBOX_MAX_FILE_MB", "5"))
SANDBOX_MAX_FILES = int(os.getenv("SANDBOX_MAX_FILES", "10"))


def _encode_file(path: Path) -> Dict[str, str]:
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return {"filename": path.name, "b64_data": data}


def _collect_output_files(workdir: Path) -> List[Dict[str, str]]:
    files: List[Dict[str, str]] = []
    max_bytes = SANDBOX_MAX_FILE_MB * 1024 * 1024
    
    # Recursively find all files (including in subdirectories)
    for path in sorted(workdir.rglob("*")):
        if not path.is_file():
            continue
        if path.name == "snippet.py":
            continue
        if path.stat().st_size > max_bytes:
            continue
        files.append(_encode_file(path))
        if len(files) >= SANDBOX_MAX_FILES:
            break
    return files


def run_user_code(code: str) -> Dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="sandbox-") as tmp_dir:
        workdir = Path(tmp_dir)
        script_path = workdir / "snippet.py"
        script_path.write_text(code, encoding="utf-8")
        
        # Pass through environment variables (InfluxDB credentials, etc.)
        # Inherit current process env and allow subprocess to access them
        env = os.environ.copy()
        
        try:
            proc = subprocess.run(
                ["python3", script_path.name],
                cwd=workdir,
                capture_output=True,
                text=True,
                timeout=SANDBOX_TIMEOUT,
                env=env,  # Pass environment to subprocess
            )
            success = proc.returncode == 0
            std_err = proc.stderr
            std_out = proc.stdout
        except subprocess.TimeoutExpired as exc:
            success = False
            std_out = exc.stdout or ""
            std_err = (exc.stderr or "") + f"\nExecution timed out after {SANDBOX_TIMEOUT}s."
            proc = None  # type: ignore[assignment]

        output_files = _collect_output_files(workdir)

    return {
        "ok": success,
        "return_code": getattr(proc, "returncode", None),
        "std_out": std_out,
        "std_err": std_err,
        "output_files": output_files,
    }


class SandboxHandler(BaseHTTPRequestHandler):
    server_version = "SandboxHTTP/1.0"

    def _send_json(self, status: HTTPStatus, payload: Dict[str, Any]) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler API)
        if self.path not in ("/", "/execute"):
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Unknown endpoint"})
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length)
        try:
            payload = json.loads(body)
            code = payload.get("code")
            if not isinstance(code, str) or not code.strip():
                raise ValueError("Request JSON must include non-empty 'code' field.")
        except (json.JSONDecodeError, ValueError) as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return

        result = run_user_code(code)
        self._send_json(HTTPStatus.OK, result)

    def log_message(self, fmt: str, *args: Any) -> None:
        # Keep logs concise for the sandbox container.
        print(f"[sandbox] {self.address_string()} - {fmt % args}")


def main() -> None:
    server = ThreadingHTTPServer(("", SANDBOX_PORT), SandboxHandler)
    print(f"Sandbox server listening on port {SANDBOX_PORT} (timeout={SANDBOX_TIMEOUT}s)")
    server.serve_forever()


if __name__ == "__main__":
    main()
