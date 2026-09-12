#!/usr/bin/env bash
# Run Vela in the emulator.
#
# The inner development loop belongs here: boot is instant, APDUs go over TCP
# on 9999, the screen is served on 5001 (5000 is AirPlay on macOS), and nothing can wedge a USB pipe.
#
# What does NOT belong here: anything about NVRAM persistence. Speculos
# emulates nvm_write, but whether the store survives a restart depends on how
# the emulator is launched — and persistence is the one claim Vela cannot
# take on faith. Verify that on the Flex.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# -it only when there is a terminal to attach. Hardcoding it makes this
# unusable from anything that is not a person at a prompt — a script, a CI
# step, a background run — and docker's refusal is "cannot attach stdin to a
# TTY-enabled container", which names the flag but not the fix.
TTY=""
[ -t 0 ] && TTY="-it"

exec docker run --rm $TTY \
  -v "$ROOT/app":/app \
  -p 5001:5000 -p 9999:9999 \
  ghcr.io/ledgerhq/speculos:latest \
  --model flex --display headless --apdu-port 9999 --api-port 5000 \
  /app/bin/app.elf "$@"
