#!/usr/bin/env python3
"""
Auth-gated reverse proxy: Cloudflare edge -> LM Studio on the desktop tailnet.

Why this exists instead of publishing LM Studio's :11435 directly:

LM Studio's OpenAI-compatible server has NO authentication. Publishing it
through a tunnel would put an unauthenticated API that can run inference, load
models and read the model list on the public internet, pointed at Ryan's actual
desktop. That is not acceptable, so this process sits in front of it.

Design:
  - Listens on 127.0.0.1 only. Reachable from the tunnel, not from the network.
  - Requires `Authorization: Bearer <LM_GATEWAY_TOKEN>` on every request.
    401 otherwise. Constant-time compare.
  - Forwards to LM_STUDIO_URL over Tailscale, where it stays unreachable from
    the public internet.
  - Only /v1/* and /api/v1/* paths are proxied; everything else is 404, so the
    LM Studio control surface (model download, load/unload) is not reachable
    through the tunnel even with a valid token.
  - Logs one line per request, no headers, no auth values.

Set LM_GATEWAY_TOKEN in the environment (systemd EnvironmentFile). Never commit it.
"""
import hmac
import os
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = int(os.environ.get("LM_GATEWAY_PORT", "8790"))
UPSTREAM = os.environ.get("LM_STUDIO_URL", "http://100.105.114.43:11435").rstrip("/")
TOKEN = os.environ.get("LM_GATEWAY_TOKEN", "")

ALLOWED_PREFIXES = ("/v1/",)

# Long generations are normal on a 3070; do not cut them off mid-answer.
UPSTREAM_TIMEOUT = float(os.environ.get("LM_UPSTREAM_TIMEOUT", "600"))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):  # quieter default logging
        pass

    def _deny(self, code: int, reason: str) -> None:
        body = json_bytes({"error": {"message": reason, "type": "gateway_error"}})
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        if not TOKEN:
            # Fail closed. An unset token must never mean "allow all".
            self.log_line(401, "no-token-configured")
            return False
        hdr = self.headers.get("Authorization", "")
        prefix, _, value = hdr.partition(" ")
        if prefix.lower() != "bearer" or not value:
            self.log_line(401, "bad-auth-shape")
            return False
        if not hmac.compare_digest(value.strip(), TOKEN):
            self.log_line(401, "bad-token")
            return False
        return True

    def log_line(self, code: int, note: str = "") -> None:
        sys.stderr.write(
            f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {self.command} {self.path} -> {code} {note}\n"
        )
        sys.stderr.flush()

    def _proxy(self, method: str) -> None:
        if not self._authorized():
            self._deny(401, "unauthorized")
            return

        # Control surface stays unreachable through the tunnel even when authorized.
        if not self.path.startswith(ALLOWED_PREFIXES):
            self.log_line(404, "path-not-allowed")
            self._deny(404, "not found")
            return

        length = int(self.headers.get("Content-Length") or 0)
        # Cap request bodies so this cannot be used as an unbounded upload sink.
        if length > 32 * 1024 * 1024:
            self.log_line(413, "body-too-large")
            self._deny(413, "request body too large")
            return
        body = self.rfile.read(length) if length else None

        req = urllib.request.Request(UPSTREAM + self.path, data=body, method=method)
        ctype = self.headers.get("Content-Type")
        if ctype:
            req.add_header("Content-Type", ctype)

        try:
            with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT) as resp:
                data = resp.read()
                self.send_response(resp.status)
                c = resp.headers.get("Content-Type", "application/json")
                self.send_header("Content-Type", c)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                self.log_line(resp.status)
        except urllib.error.HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            self.log_line(e.code, "upstream-http")
        except Exception as e:
            self.log_line(502, f"upstream-{type(e).__name__}")
            self._deny(502, f"upstream unavailable: {type(e).__name__}")

    def do_GET(self):
        self._proxy("GET")

    def do_POST(self):
        self._proxy("POST")


def json_bytes(obj) -> bytes:
    import json

    return json.dumps(obj).encode()


def main() -> None:
    if not TOKEN:
        sys.stderr.write("FATAL: LM_GATEWAY_TOKEN is unset -- refusing to start (fail closed)\n")
        raise SystemExit(1)
    srv = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    srv.daemon_threads = True
    sys.stderr.write(f"lm-gateway listening on {LISTEN_HOST}:{LISTEN_PORT} -> {UPSTREAM}\n")
    sys.stderr.flush()
    srv.serve_forever()


if __name__ == "__main__":
    main()
