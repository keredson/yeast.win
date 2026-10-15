#!/usr/bin/env python3
"""Socket-activated, single-deployment HTTP hook for Yeast.Win."""

from __future__ import annotations

import hashlib
import hmac
import http.server
import json
import os
from pathlib import Path
import re
import socket
import socketserver
import subprocess
import time
from typing import Any
from urllib.parse import urlparse

DEPLOY_SCRIPT = "/usr/local/libexec/yeast-win/deploy-release"
STATUS_DIR = Path("/var/lib/yeast-deploy/status")
LOG_DIR = Path("/var/lib/yeast-deploy/logs")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
RUN_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
MAX_BODY = 4096
MAX_CLOCK_SKEW = 300


def valid_signature(secret: str, timestamp: str, body: bytes, supplied: str,
                    now: int | None = None) -> bool:
    try:
        request_time = int(timestamp)
    except ValueError:
        return False
    if abs((int(time.time()) if now is None else now) - request_time) > MAX_CLOCK_SKEW:
        return False
    expected = hmac.new(secret.encode(), timestamp.encode() + b"." + body,
                        hashlib.sha256).hexdigest()
    return hmac.compare_digest(f"sha256={expected}", supplied)


def write_status(run_id: str, status: dict[str, Any]) -> None:
    STATUS_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = STATUS_DIR / f".{run_id}.{os.getpid()}.tmp"
    temporary.write_text(json.dumps(status, separators=(",", ":")) + "\n")
    temporary.chmod(0o600)
    temporary.replace(STATUS_DIR / f"{run_id}.json")


def read_status(run_id: str) -> dict[str, Any] | None:
    try:
        return json.loads((STATUS_DIR / f"{run_id}.json").read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


class DeployHandler(http.server.BaseHTTPRequestHandler):
    server_version = "YeastDeployHook/1"

    def log_message(self, format_string: str, *args: object) -> None:
        print(f"local - {format_string % args}", flush=True)

    def reply(self, status: int, value: dict[str, Any]) -> None:
        body = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        match = re.fullmatch(r"/status/([A-Za-z0-9._-]{1,80})", urlparse(self.path).path)
        if not match:
            self.reply(404, {"error": "not found"})
            return
        status = read_status(match.group(1))
        self.reply(200, status) if status else self.reply(404, {"error": "deployment not found"})

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if urlparse(self.path).path != "/deploy":
            self.reply(404, {"error": "not found"})
            return
        if getattr(self.server, "deployment", None) is not None:
            self.reply(409, {"error": "a deployment is already running"})
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY:
            self.reply(413, {"error": "invalid request size"})
            return
        body = self.rfile.read(length)
        secret = os.environ.get("YEAST_DEPLOY_SECRET", "")
        if not secret or not valid_signature(secret, self.headers.get("X-Yeast-Timestamp", ""), body,
                                             self.headers.get("X-Yeast-Signature", "")):
            self.reply(401, {"error": "invalid deployment signature"})
            return
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self.reply(400, {"error": "invalid JSON"})
            return
        commit = payload.get("commit") if isinstance(payload, dict) else None
        run_id = payload.get("run_id") if isinstance(payload, dict) else None
        if not isinstance(commit, str) or not COMMIT_RE.fullmatch(commit):
            self.reply(400, {"error": "invalid commit"})
            return
        if not isinstance(run_id, str) or not RUN_ID_RE.fullmatch(run_id):
            self.reply(400, {"error": "invalid run ID"})
            return

        LOG_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
        log_path = LOG_DIR / f"{run_id}.log"
        log_file = log_path.open("ab", buffering=0)
        write_status(run_id, {"run_id": run_id, "commit": commit, "state": "running"})
        child_environment = os.environ.copy()
        child_environment.pop("YEAST_DEPLOY_SECRET", None)
        try:
            process = subprocess.Popen([DEPLOY_SCRIPT, commit, run_id], stdout=log_file,
                                       stderr=subprocess.STDOUT, close_fds=True, env=child_environment)
        except OSError as error:
            log_file.close()
            write_status(run_id, {"run_id": run_id, "commit": commit, "state": "failed",
                                  "error": str(error)})
            self.reply(500, {"error": "could not start deployment"})
            return
        self.server.deployment = (process, log_file, run_id, commit)  # type: ignore[attr-defined]
        self.reply(202, {"run_id": run_id, "commit": commit, "state": "running"})


class ActivatedUnixServer(socketserver.UnixStreamServer):
    deployment: tuple[subprocess.Popen[bytes], Any, str, str] | None = None

    def __init__(self) -> None:
        super().__init__(None, DeployHandler, bind_and_activate=False)
        self.socket.close()
        self.socket = socket.socket(fileno=3)
        self.server_address = self.socket.getsockname()
        self.timeout = 1


def main() -> int:
    server = ActivatedUnixServer()
    server.handle_request()
    if server.deployment is None:
        return 0

    process, log_file, run_id, commit = server.deployment
    while process.poll() is None:
        server.handle_request()
    log_file.close()
    state = "succeeded" if process.returncode == 0 else "failed"
    write_status(run_id, {"run_id": run_id, "commit": commit, "state": state,
                          "exit_code": process.returncode})

    # Stay available briefly so the triggering workflow can observe completion.
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        server.handle_request()
    return process.returncode or 0


if __name__ == "__main__":
    raise SystemExit(main())
