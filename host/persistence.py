#!/usr/bin/env python3
"""
The test that proves the thesis.

Read the counters, exit the app, restart it, read them again. If they match,
the envelope survived a full application lifecycle — it lives in the Secure
Element, not in the host's memory or a file the host can rewrite.

One HID handle at a time: opening a second while the first is live deadlocks
on macOS.
"""
import struct
import subprocess
import sys
import time

from ledgerblue.comm import getDongle
from ledgerblue.commException import CommException

CLA, INS_GET, INS_QUIT = 0xE0, 0x10, 0x15
TINYBAR = 100_000_000


def read_slots():
    """Snapshot every slot, then let go of the device."""
    d = getDongle(False)
    try:
        out = []
        for slot in range(3):
            try:
                r = d.exchange(bytes([CLA, INS_GET, slot, 0, 0]))
                budget, reserved, spent, per_call, available = struct.unpack(">QQQQQ", r[21:61])
                expiry, seq = struct.unpack(">II", r[61:69])
                out.append(dict(slot=slot, agent=r[1:21].hex()[:8], budget=budget,
                                spent=spent, available=available, seq=seq))
            except CommException as e:
                out.append(dict(slot=slot, free=True) if e.sw == 0xB102 else
                           dict(slot=slot, error=f"0x{e.sw:04x}"))
        return out
    finally:
        d.close()


def show(label, slots):
    print(f"\n{label}")
    for s in slots:
        if s.get("free"):
            print(f"  slot {s['slot']}: free")
        elif s.get("error"):
            print(f"  slot {s['slot']}: {s['error']}")
        else:
            print(f"  slot {s['slot']}: agent {s['agent']}  "
                  f"spent {s['spent']/TINYBAR:g}/{s['budget']/TINYBAR:g} HBAR  "
                  f"draws {s['seq']}")


def quit_app():
    d = getDongle(False)
    try:
        d.exchange(bytes([CLA, INS_QUIT, 0, 0, 0]))
    except Exception:
        pass  # the app exits mid-exchange; there is no reply to read
    finally:
        try:
            d.close()
        except Exception:
            pass


def run_app():
    subprocess.run([sys.executable, "-m", "ledgerwallet.ledgerctl", "run", "Vela"],
                   capture_output=True)


def main():
    before = read_slots()
    show("before — counters as the chip holds them:", before)

    print("\n  exiting the app...")
    quit_app()
    time.sleep(3)

    print("  restarting it...")
    run_app()
    time.sleep(3)

    after = read_slots()
    show("after a full application restart:", after)

    same = before == after
    print()
    if same:
        print("  IDENTICAL. The envelope survived the app being torn down and")
        print("  brought back. It was never in this host's memory to begin with.")
    else:
        print("  MISMATCH — the state did not survive. This is the one thing")
        print("  Vela cannot afford to get wrong.")
    return 0 if same else 1


if __name__ == "__main__":
    sys.exit(main())
