#!/usr/bin/env python3
"""One bounded APDU round trip per invocation. who | read | quit | run"""
import signal, struct, subprocess, sys

signal.signal(signal.SIGALRM, lambda *a: (print("TIMEOUT"), sys.exit(2)))
signal.alarm(15)

from ledgerblue.comm import getDongle
from ledgerblue.commException import CommException

cmd = sys.argv[1] if len(sys.argv) > 1 else "who"

if cmd == "run":
    subprocess.run([sys.executable, "-m", "ledgerwallet.ledgerctl", "run", "Vela"],
                   capture_output=True)
    print("run issued")
    sys.exit(0)

d = getDongle(False)

if cmd == "who":
    r = bytes(d.exchange(bytes.fromhex("b001000000")))
    print(r[2:2 + r[1]].decode("ascii", "replace"))

elif cmd == "read":
    for s in range(3):
        try:
            r = bytes(d.exchange(bytes([0xE0, 0x10, s, 0, 0])))
            b, rs, sp, pc, av = struct.unpack(">QQQQQ", r[21:61])
            _, seq = struct.unpack(">II", r[61:69])
            print(f"slot{s} agent={r[1:21].hex()[:8]} spent={sp} budget={b} avail={av} draws={seq}")
        except CommException as e:
            print(f"slot{s} " + ("free" if e.sw == 0xB102 else f"sw=0x{e.sw:04x}"))

elif cmd == "quit":
    # No reply comes back: the app is torn down mid-exchange.
    try:
        d.exchange(bytes([0xE0, 0x15, 0, 0, 0]))
    except Exception:
        pass
    print("quit issued")
