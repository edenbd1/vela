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

# Ask the SDK what flags this build actually wants, rather than carrying a
# hardcoded copy that drifts from the Makefile.
APP_FLAGS=$(make -n load 2>/dev/null | tr ' ' '\n' | grep -A1 -- '--appFlags' | tail -1)
APP_FLAGS=${APP_FLAGS:-0x0}

# Refuse privileged flags, loudly.
#
# 0x200 is BOLOS_SETTINGS: permission to change the operating system's own
# settings. Installing an app that asks for it, unsigned by Ledger, onto a
# device holding a seed, factory-resets that device — twenty-four words and
# all. It happened twice here before anyone thought to look at a number the
# loader prints without comment.
#
# It was not asked for. ENABLE_BLUETOOTH=1, which the boilerplate ships by
# default and this app never used, sets it on Flex through
# Makefile.standard_app. So the check is on the flags themselves rather than
# on the option that happened to cause it this time: any privileged bit
# stops the load.
#
#   0x10 DERIVE_MASTER   0x40 GLOBAL_PIN   0x200 BOLOS_SETTINGS   0x800 LIBRARY
PRIVILEGED=$(( $APP_FLAGS & 0xA50 ))
if [ "$PRIVILEGED" -ne 0 ]; then
  cat >&2 <<MSG

REFUSING TO LOAD — this build asks for privileged flags ($APP_FLAGS).

  Installing an unsigned app with privileged flags onto an onboarded
  device factory-resets it. The seed goes. Ledger Wallet will show a
  brand-new device and ask for your twenty-four words.

  Find what turns them on before loading. On Flex, ENABLE_BLUETOOTH=1
  and ENABLE_NFC=1 each set BOLOS_SETTINGS (0x200) by way of
  \$BOLOS_SDK/Makefile.standard_app.

  Override with VELA_ALLOW_PRIVILEGED=1 if you genuinely mean it.

MSG
  [ "${VELA_ALLOW_PRIVILEGED:-0}" = "1" ] || exit 1
fi

echo "appFlags=$APP_FLAGS"

python3 -m ledgerblue.loadApp \
  --targetId 0x33300004 --targetVersion="" --apiLevel 26 \
  --fileName bin/app.hex --appName "Vela" --appFlags "$APP_FLAGS" --tlv \
  --dataSize "$DATA_SIZE" --installparamsSize "$PARAMS_SIZE" "$@"
