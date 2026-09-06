#!/usr/bin/env bash
# NVRAM persistence: the claim the whole project rests on.
#
# Read the counters, tear the application down, bring it back, read again.
# Equality means the envelope lives in the Secure Element rather than in
# this host's memory or a file this host could rewrite.
#
# One process per phase, each bounded by probe.py's own alarm. The macOS HID
# pipe wedges when a handle outlives a device state change, and a wedged
# handle poisons every call after it.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# This test owns the device. It quits and relaunches the application, which
# the bridge cannot relay — it is not holding the dashboard, and it does not
# survive the app exiting mid-exchange. So the bridge is stopped for the
# duration and put back afterwards, rather than the test failing with an
# empty app name and a diff that looks like lost NVRAM.
BRIDGE_WAS_UP=0
if curl -s -m 3 -X POST http://127.0.0.1:8099/apdu \
     -H 'content-type: application/json' -d '{"apdu":"b001000000"}' >/dev/null 2>&1; then
  BRIDGE_WAS_UP=1
  echo "stopping host/bridge.py for the duration of this test"
  pkill -f "host/bridge.py" 2>/dev/null
  sleep 2
fi

restore_bridge() {
  if [ "$BRIDGE_WAS_UP" = "1" ]; then
    echo
    echo "restarting host/bridge.py"
    python3 host/bridge.py >/tmp/bridge.log 2>&1 &
    disown 2>/dev/null
    sleep 3
  fi
}
trap restore_bridge EXIT

export VELA_NO_BRIDGE=1

probe() { python3 host/probe.py "$1" 2>/dev/null; }

[ "$(probe who)" = "Vela" ] || { probe run >/dev/null; sleep 3; }
[ "$(probe who)" = "Vela" ] || { echo "cannot reach the Vela app"; exit 1; }

echo "--- before ---"
probe read | tee /tmp/vela_before.txt

echo
echo "--- tearing the app down ---"
probe quit >/dev/null   # never answers: the app exits mid-exchange
sleep 3
echo "device is running: $(probe who)"

echo
echo "--- bringing it back ---"
probe run >/dev/null
sleep 3
echo "device is running: $(probe who)"

echo
echo "--- after ---"
probe read | tee /tmp/vela_after.txt

echo
if diff -q /tmp/vela_before.txt /tmp/vela_after.txt >/dev/null; then
  echo "IDENTICAL — the envelope survived a full application restart."
  exit 0
else
  echo "MISMATCH — the state did not survive:"
  diff /tmp/vela_before.txt /tmp/vela_after.txt
  exit 1
fi
