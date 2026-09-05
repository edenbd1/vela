#!/usr/bin/env bash
# Load the built app onto a physically connected Ledger Flex.
#
# Runs on the host: Docker Desktop on macOS has no USB passthrough, so the
# in-container `make load` cannot reach the device.
#
# `ledgerctl install` does NOT work here: its TOML manifest has no field for
# installparamsSize, and it only sends apiLevel for the Nano S+ — the device
# answers 0x6512 on CREATE_APP. These are the parameters `make -n load`
# reports, which is the authoritative source.
#
# Quit Ledger Wallet first: it holds the HID handle and produces erratic
# status words on commands that worked moments earlier.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/app"

sym() { grep "$1" debug/app.map | tr -s ' ' | cut -f2 -d' ' | cut -f2 -dx | head -1; }
DATA_SIZE=$((   0x$(sym _envram_data)        - 0x$(sym _nvram_data) ))
PARAMS_SIZE=$(( 0x$(sym _einstall_parameters) - 0x$(sym _install_parameters) ))
echo "dataSize=$DATA_SIZE installparamsSize=$PARAMS_SIZE"

python3 -m ledgerblue.loadApp \
  --targetId 0x33300004 --targetVersion="" --apiLevel 26 \
  --fileName bin/app.hex --appName "Vela" --appFlags 0x200 --tlv \
  --dataSize "$DATA_SIZE" --installparamsSize "$PARAMS_SIZE" "$@"
