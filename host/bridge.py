#!/usr/bin/env python3
"""
A thin HTTP shim in front of the device.

Node needs to send APDUs, and @ledgerhq/hw-transport-node-hid ships an ESM
build with extensionless imports that Node cannot load, plus a native module
that does not build here. Rather than fight that, the JavaScript side talks
HTTP to this, and this talks to the device through the transport that
already works.

It carries bytes and nothing else. It cannot approve, cannot widen a limit,
and holds no key — put it on the untrusted side of your diagram.

    python3 host/bridge.py               # USB
    VELA_SPECULOS=1 python3 host/bridge.py

    curl -X POST localhost:8099/apdu -d '{"apdu":"e016000000"}'
"""
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import journal

# Which app this bridge is guarding.
#
# The check exists because the dashboard answers app APDUs with plausible
# bytes and a success status, so a closed app surfaces much later as a
# protocol mismatch. That reasoning holds for any app — but the app was
# hardcoded, so reaching the Key Ring protocol, which lives in Ledger Sync,
# meant the bridge refused every command with advice to open Vela.
#
#   VELA_BRIDGE_APP="Ledger Sync" python3 host/bridge.py
EXPECT_APP = os.environ.get("VELA_BRIDGE_APP", "Vela")
from transport import open_device, where

PORT = int(os.environ.get("VELA_BRIDGE_PORT", "8099"))

# One device, one caller at a time. APDUs are a request/response conversation
# and interleaving two of them corrupts both.
lock = threading.Lock()
device = None


# A grant waits for a human to read four pages and hold a button. The
# transport's default of a few seconds expires long before that, and the
# failure does not look like a timeout — it looks like the app refusing.
APPROVAL_TIMEOUT_MS = 180_000


def running_app(dev) -> str:
    """Which application is listening. 'BOLOS' means the dashboard."""
    r = bytes(dev.exchange(bytes.fromhex("b001000000")))
    return r[2:2 + r[1]].decode("ascii", "replace")


def exchange(apdu: bytes):
    global device
    with lock:
        if device is None:
            device = open_device()

        # Ask who is listening before every command. The dashboard answers
        # app APDUs with plausible-looking bytes and a success status, so a
        # closed app surfaces much later as a protocol mismatch — or, worse,
        # as a wrong number nobody questions.
        if apdu[:2] != bytes.fromhex("b001"):
            app = running_app(device)
            if app != EXPECT_APP:
                # Worth a journal line: the app vanishing between two commands
                # is how a crash looks from here, and a crash is one of the
                # things protection mode may be reacting to.
                journal.record("app_not_running", saw=app, ins=apdu[1])
                raise RuntimeError(
                    f"the device is on '{app}', not {EXPECT_APP} — open the app "
                    f"and stay on it"
                )

        try:
            r = bytes(device.exchange(apdu, timeout=APPROVAL_TIMEOUT_MS)), 0x9000
            journal.record("apdu", cla=apdu[0], ins=apdu[1], lc=len(apdu) - 5, sw="9000")
            return r
        except Exception as e:
            sw = getattr(e, "sw", None)
            if sw is None:
                # The pipe went bad; drop it so the next call reconnects
                # rather than inheriting a wedged handle.
                journal.record("transport_error", cla=apdu[0], ins=apdu[1],
                               error=str(e)[:120])
                device = None
                raise
            journal.record("apdu", cla=apdu[0], ins=apdu[1], lc=len(apdu) - 5,
                           sw=f"{sw:04x}")
            return getattr(e, "data", b"") or b"", sw


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def _reply(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/health":
            self._reply(200, {"ok": True, "transport": where()})
        else:
            self._reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/apdu":
            return self._reply(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length", 0))
        try:
            apdu = bytes.fromhex(json.loads(self.rfile.read(n))["apdu"])
        except Exception as e:
            return self._reply(400, {"error": f"bad request: {e}"})
        try:
            data, sw = exchange(apdu)
            self._reply(200, {"data": data.hex(), "sw": sw})
        except Exception as e:
            self._reply(502, {"error": str(e)})


if __name__ == "__main__":
    print(f"device bridge on :{PORT}, transport {where()}")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
