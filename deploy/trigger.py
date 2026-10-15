#!/usr/bin/env python3
"""Trigger a Yeast.Win deployment and wait for its socket-activated job."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def request_json(url: str, headers: dict[str, str], data: bytes | None = None) -> dict:
    request = Request(url, data=data, headers=headers, method="POST" if data is not None else "GET")
    try:
        with urlopen(request, timeout=30) as response:
            return json.load(response)
    except HTTPError as error:
        detail = error.read(2048).decode(errors="replace")
        raise RuntimeError(f"deployment endpoint returned HTTP {error.code}: {detail}") from error


def main() -> int:
    deploy_url = os.environ["YEAST_DEPLOY_URL"].rstrip("/") + "/deploy"
    secret = os.environ["YEAST_DEPLOY_SECRET"]
    commit = os.environ["GITHUB_SHA"]
    run_id = f"{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}"
    body = json.dumps({"commit": commit, "run_id": run_id}, separators=(",", ":")).encode()
    timestamp = str(int(time.time()))
    signature = hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
    headers = {
        "Content-Type": "application/json",
        "X-Yeast-Timestamp": timestamp,
        "X-Yeast-Signature": f"sha256={signature}",
    }
    client_id = os.environ.get("CF_ACCESS_CLIENT_ID")
    client_secret = os.environ.get("CF_ACCESS_CLIENT_SECRET")
    if bool(client_id) != bool(client_secret):
        raise RuntimeError("both Cloudflare Access credentials must be configured together")
    if client_id:
        headers["CF-Access-Client-Id"] = client_id
        headers["CF-Access-Client-Secret"] = client_secret or ""

    started = request_json(deploy_url, headers, body)
    print(f"deployment {started['run_id']} accepted for {started['commit']}")
    status_url = deploy_url.rsplit("/", 1)[0] + f"/status/{run_id}"
    deadline = time.monotonic() + 15 * 60
    last_state = None
    while time.monotonic() < deadline:
        status = request_json(status_url, headers)
        if status.get("state") != last_state:
            print(f"deployment state: {status.get('state')}")
            last_state = status.get("state")
        if status.get("state") == "succeeded":
            return 0
        if status.get("state") == "failed":
            print(f"deployment failed with exit code {status.get('exit_code')}", file=sys.stderr)
            return 1
        time.sleep(5)
    print("timed out waiting for deployment", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
