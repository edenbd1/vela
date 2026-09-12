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

# Everything that needs no chip.
#
# One function, called from both paths, because it was two copies and I added
# a suite to each of them by hand three times. The next divergence would have
# been a suite that runs on the emulator and not on hardware, or the reverse,
# and nobody would notice until it mattered.
#
# `on_device` is passed through to the console suite: with a device attached
# it also presses the buttons that ask the chip, which the emulator cannot
# answer for.
host_suites() {
  local on_device="${1:-}"

  # The documentation, checked the way everything else here is. Four bugs in
  # one day were things written down that had quietly stopped being true —
  # including this script being described as running a suite it never ran.
  # It costs under a second and it is the only assertion in this file about
  # the artefact a judge actually reads.
  echo "the documentation"
  if ! ./scripts/docs-check.sh 2>&1 | grep -E "^  (\x1b\[3[12]m)?[✓✗]" | sed 's/^ */  /'; then
    echo "  the docs describe a previous repository" >&2
    exit 1
  fi

  # Fast, needs nothing, and covers the two places on this side where being
  # wrong is expensive: what a broker will let an agent make it fetch, and
  # whether a published chain adds up.
  echo "host logic"
  if ! node --test test/logic.test.mjs 2>&1 | grep -E "^# (pass|fail)" | sed 's/^# /  /'; then
    echo "  host-side tests failed" >&2
    exit 1
  fi
  node --test test/logic.test.mjs >/dev/null 2>&1 || exit 1

  # The browser verifier against the Node one, over nine chain shapes. This
  # suite existed, passed, and was described in the README as part of what
  # this script covers — and this script never ran it. A verifier that agrees
  # with itself in a terminal and disagrees in a browser is the one failure
  # the last shot of the demo would show a judge.
  echo "the browser verifier"
  if ! node --test test/chain-parity.test.mjs 2>&1 | grep -E "^# (pass|fail)" | sed 's/^# /  /'; then
    echo "  chain-parity tests failed" >&2
    exit 1
  fi
  node --test test/chain-parity.test.mjs >/dev/null 2>&1 || exit 1

  # The console lending the Flex back to the stack. Connecting the Ledger
  # from the page used to take the device away from host/bridge.py and leave
  # every other figure on the screen reading ECONNREFUSED, and no suite here
  # could see it. The property that matters is that the relay lets go: a port
  # left bound to a closed tab is a bridge that will not start.
  echo "the browser as bridge"
  if ! node --test test/relay.test.mjs 2>&1 | grep -E "^# (pass|fail)" | sed 's/^# /  /'; then
    echo "  relay tests failed" >&2
    exit 1
  fi
  node --test test/relay.test.mjs >/dev/null 2>&1 || exit 1

  # Refusal-handling is a property of the loop, not of the model's mood on the
  # day, so it runs against a fake gateway, a fake broker and a scripted model
  # on ephemeral ports — with the real agent/reason.mjs as a child process.
  echo "the agent loop"
  if ! node test/agent.test.mjs | tail -2 | sed 's/^/  /'; then
    echo "  agent tests failed" >&2
    exit 1
  fi

  # The trustchain arithmetic is the same whether the owner key came out of
  # the Key Ring or out of the test, so what matters — a member derives rather
  # than receives, a stranger cannot — is checkable with no device.
  echo "ring enrolment"
  if ! node test/ring.test.mjs | tail -2 | sed 's/^/  /'; then
    echo "  enrolment tests failed" >&2
    exit 1
  fi

  # The only surface here a person looks at rather than reads, and nothing was
  # checking it worked: app.js spent several commits referencing elements
  # index.html did not have, dying on load, while the fleet list still painted.
  echo "the console"
  if curl -s -m 3 http://127.0.0.1:4050/api/config >/dev/null 2>&1; then
    # The exit code, not just the last line. `suite | tail -1` reports the
    # pipeline's tail, which succeeds whatever the suite did — so this step
    # printed "15/22 passed" and the run still exited 0. Every other step here
    # was already guarded; this one had been quietly advisory since it was
    # added, which is the worst kind of test: one that is watched and cannot
    # fail the thing watching it.
    local out
    out=$(python3 test/console_test.py $on_device) || {
      echo "$out" | grep -E "FAIL|passed" | sed 's/^/  /'
      echo "  console tests failed" >&2
      exit 1
    }
    echo "$out" | tail -1 | sed 's/^/  /'
  else
    echo "  not running on :4050 — skipped"
  fi
  echo ""
}

if [ "${1:-}" = "--device" ]; then
  if ! curl -s -m 8 -X POST http://127.0.0.1:8099/apdu \
       -H 'content-type: application/json' -d '{"apdu":"b001000000"}' >/dev/null 2>&1; then
    echo "no bridge on :8099 — start host/bridge.py, with Vela open" >&2
    exit 1
  fi
  host_suites --device
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
host_suites

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
