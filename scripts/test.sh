#!/usr/bin/env bash
# What the chip enforces, asserted rather than demonstrated.
#
# Runs against Speculos on purpose. These are protocol assertions and the
# emulator runs the same ELF, so they are fast and repeatable — and a suite
# that needs a person to tap five times is a suite nobody runs.
#
# Two claims are deliberately out of scope here and belong on hardware:
# whether NVRAM survives a restart (scripts/persistence-test.sh) and anything
# about real signatures, since the emulator signs correctly for a key that
# owns nothing.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --device runs the same assertions against the Flex. Slower, needs three
# approvals, and it is the only way to know the emulator has not been lying —
# the whole reason the divergence between them is written up in
# docs/PROTECTION-MODE.md.
if [ "${1:-}" = "--device" ]; then
  if ! curl -s -m 8 -X POST http://127.0.0.1:8099/apdu \
       -H 'content-type: application/json' -d '{"apdu":"b001000000"}' >/dev/null 2>&1; then
    echo "no bridge on :8099 — start host/bridge.py, with Vela open" >&2
    exit 1
  fi
  echo "host logic"
  node --test test/logic.test.mjs 2>&1 | grep -E "^# (pass|fail)" | sed 's/^# /  /'
  node --test test/logic.test.mjs >/dev/null 2>&1 || exit 1

# The agent loop. Refusal-handling is a property of the loop, not of the
# model's mood on the day, so it is tested against a fake gateway, a fake
# broker and a scripted model on ephemeral ports — with the real
# agent/reason.mjs run as a child process exactly as it ships.
echo "the agent loop"
if ! node test/agent.test.mjs | tail -2 | sed 's/^/  /'; then
  echo "  agent tests failed" >&2
  exit 1
fi
  exec python3 test/chip_test.py
fi

IMAGE="ghcr.io/ledgerhq/speculos:latest"
NAME="vela-test"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# The host-side logic first: it needs nothing, runs in a fifth of a second,
# and covers the two places on this side where being wrong is expensive —
# what a broker will let an agent make it fetch, and whether a published
# chain adds up. No reason to boot an emulator to find out one of those broke.
echo "host logic"
if ! node --test test/logic.test.mjs 2>&1 | grep -E "^# (pass|fail)" | sed 's/^# /  /'; then
  echo "  host-side tests failed" >&2
  exit 1
fi
node --test test/logic.test.mjs >/dev/null 2>&1 || exit 1

# The agent loop. Refusal-handling is a property of the loop, not of the
# model's mood on the day, so it is tested against a fake gateway, a fake
# broker and a scripted model on ephemeral ports — with the real
# agent/reason.mjs run as a child process exactly as it ships.
echo "the agent loop"
if ! node test/agent.test.mjs | tail -2 | sed 's/^/  /'; then
  echo "  agent tests failed" >&2
  exit 1
fi

if [ ! -f app/bin/app.elf ]; then
  echo "no build — run ./scripts/build.sh first" >&2
  exit 1
fi

# A bridge holding the USB device would make transport.py prefer hardware,
# and these tests would then need a person. Point it at the emulator instead.
export VELA_SPECULOS=1

cleanup
docker run -d --name "$NAME" -v "$PWD/app":/app -p 5001:5000 -p 9999:9999 \
  "$IMAGE" --model flex --display headless --apdu-port 9999 --api-port 5000 \
  /app/bin/app.elf >/dev/null

for _ in $(seq 1 30); do
  curl -s -m 2 http://127.0.0.1:5001/events >/dev/null 2>&1 && break
  sleep 1
done

python3 test/chip_test.py
