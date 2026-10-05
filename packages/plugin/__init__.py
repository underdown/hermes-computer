"""hermes-computer — route tool calls to sandboxed Computer workspaces.

Replaces local tool execution with Cloudflare Computer sandboxed execution.
terminal → Container backend, execute_code → Isolate JS, file tools → DOFS.
"""

import os, json, urllib.request, threading, logging

logger = logging.getLogger("hermes-computer")
BRIDGE_URL = os.environ.get("HERMES_COMPUTER_URL", "")
SESSION_ID = os.environ.get("HERMES_COMPUTER_SESSION", "default")

def _post(path, args):
    """Fire-and-forget POST to the bridge Worker."""
    def _send():
        try:
            data = json.dumps({"args": args}).encode()
            req = urllib.request.Request(
                f"{BRIDGE_URL}{path}", data=data,
                headers={"Content-Type": "application/json", "X-Session-Id": SESSION_ID},
                method="POST"
            )
            resp = urllib.request.urlopen(req, timeout=30)
            return resp.read().decode()
        except Exception as e:
            return json.dumps({"error": str(e)})
    return _send()

def register(ctx):
    logger.info(f"hermes-computer: routing tools to {BRIDGE_URL}")
