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
#
# In the builder image, not on the host: `make -n load` needs BOLOS_SDK and the
# ARM toolchain, and on macOS it simply fails. A first version of this check
# ran it here, got nothing, and defaulted to 0x0 — which is the safe value, so
# it looked like it worked while checking nothing at all. A guard that cannot
# fail is not a guard.
IMAGE="ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder:latest"
APP_FLAGS=$(docker run --rm -v "$ROOT":/repo -w /repo/app -e BOLOS_SDK=/opt/flex-secure-sdk \
              "$IMAGE" bash -c "make -n load 2>/dev/null" 2>/dev/null \
            | tr ' ' '\n' | grep -A1 -- '--appFlags' | tail -1)

if [ -z "$APP_FLAGS" ]; then
  echo "could not read --appFlags from the SDK — refusing to guess" >&2
  exit 1
fi

# Refuse privileged flags, loudly.
#
# 0x200 is BOLOS_SETTINGS: permission to change the operating system's own
# settings. Vela does not need it and never asked for it — ENABLE_BLUETOOTH=1,
# which the boilerplate ships by default and this app never used, grants it on
# Flex through Makefile.standard_app.
#
# An app should not carry privileges it does not use, and this one is
# invisible unless you know to run `make -n load` and know what the number
# means. So the check is on the flags themselves rather than on whichever
# option turned them on: any privileged bit stops the load and says which.
#
#   0x10 DERIVE_MASTER   0x40 GLOBAL_PIN   0x200 BOLOS_SETTINGS   0x800 LIBRARY
PRIVILEGED=$(( $APP_FLAGS & 0xA50 ))
if [ "$PRIVILEGED" -ne 0 ]; then
  cat >&2 <<MSG

REFUSING TO LOAD — this build asks for privileged flags ($APP_FLAGS).

  This app is asking for permissions it may not need. Find what turns
  them on before loading. On Flex, ENABLE_BLUETOOTH=1
  and ENABLE_NFC=1 each set BOLOS_SETTINGS (0x200) by way of
  \$BOLOS_SDK/Makefile.standard_app.

  Override with VELA_ALLOW_PRIVILEGED=1 if you genuinely mean it.

MSG
  [ "${VELA_ALLOW_PRIVILEGED:-0}" = "1" ] || exit 1
fi

echo "appFlags=$APP_FLAGS"

# Every load opens a secure channel with a freshly generated root key, which
# the device reports as a broken certificate chain. That is the leading
# suspect for what put this Flex into protection mode three times, so each one
# gets a line on disk — see docs/PROTECTION-MODE.md.
python3 - "$APP_FLAGS" <<'JOURNAL'
import sys, os
sys.path.insert(0, os.path.join(os.getcwd(), "..", "host"))
sys.path.insert(0, os.path.join(os.path.dirname(os.getcwd()), "host"))
try:
    import journal
    journal.record("load_app", app_flags=sys.argv[1], via="ledgerblue.loadApp")
except Exception:
    pass
JOURNAL

python3 -m ledgerblue.loadApp \
  --targetId 0x33300004 --targetVersion="" --apiLevel 26 \
  --fileName bin/app.hex --appName "Vela" --appFlags "$APP_FLAGS" --tlv \
  --dataSize "$DATA_SIZE" --installparamsSize "$PARAMS_SIZE" "$@"
