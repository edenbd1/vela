#!/usr/bin/env bash
# NVRAM persistence, one phase per process.
#
# The device changes state under us — the app exits, the dashboard takes
# over, the app starts again. A single long-lived process cannot hold an HID
# handle across that on macOS, so each phase gets its own.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

q() { python3 -c "$1" 2>/dev/null; }

WHO='
from ledgerblue.comm import getDongle
d=getDongle(False); r=bytes(d.exchange(bytes.fromhex("b001000000"))); d.close()
print(r[2:2+r[1]].decode("ascii","replace"))'

READ='
import struct
from ledgerblue.comm import getDongle
from ledgerblue.commException import CommException
d=getDongle(False)
for s in range(3):
    try:
        r=d.exchange(bytes([0xE0,0x10,s,0,0]))
        b,rs,sp,pc,av=struct.unpack(">QQQQQ", bytes(r)[21:61])
        e,q=struct.unpack(">II", bytes(r)[61:69])
        print(f"slot{s} agent={bytes(r)[1:21].hex()[:8]} spent={sp} budget={b} avail={av} draws={q}")
    except CommException as ex:
        print(f"slot{s} " + ("free" if ex.sw==0xB102 else f"sw=0x{ex.sw:04x}"))
d.close()'

QUIT='
from ledgerblue.comm import getDongle
d=getDongle(False)
try: d.exchange(bytes([0xE0,0x15,0,0,0]))
except Exception: pass
try: d.close()
except Exception: pass'

echo "device is running: $(q "$WHO")"
[ "$(q "$WHO")" = "Vela" ] || { python3 -m ledgerwallet.ledgerctl run Vela >/dev/null 2>&1; sleep 3; }

echo; echo "--- before ---"; q "$READ" | tee /tmp/vela_before.txt

echo; echo "--- exiting the app ---"; q "$QUIT"; sleep 3
echo "device is running: $(q "$WHO")"

echo; echo "--- restarting ---"; python3 -m ledgerwallet.ledgerctl run Vela >/dev/null 2>&1; sleep 3
echo "device is running: $(q "$WHO")"

echo; echo "--- after ---"; q "$READ" | tee /tmp/vela_after.txt

echo
if diff -q /tmp/vela_before.txt /tmp/vela_after.txt >/dev/null; then
  echo "IDENTICAL — the envelope survived a full application restart."
else
  echo "MISMATCH:"; diff /tmp/vela_before.txt /tmp/vela_after.txt
fi
