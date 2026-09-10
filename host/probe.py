#!/usr/bin/env python3
"""One bounded APDU round trip per invocation. who | read | quit | run"""
import signal, struct, subprocess, sys

signal.signal(signal.SIGALRM, lambda *a: (print("TIMEOUT"), sys.exit(2)))
signal.alarm(15)

import transport
from transport import open_device
from ledgerblue.commException import CommException as _BlueComm

# Two classes, one meaning. Direct USB raises ledgerblue's; the bridge raises
# transport's own. Catching only one of them turned a status word into a
# traceback the moment a free slot was read through the bridge.
CommException = (transport.CommException, _BlueComm)

cmd = sys.argv[1] if len(sys.argv) > 1 else "who"

if cmd == "run":
    subprocess.run([sys.executable, "-m", "ledgerwallet.ledgerctl", "run", "Vela"],
                   capture_output=True)
    print("run issued")
    sys.exit(0)

d = open_device()

if cmd == "who":
    r = bytes(d.exchange(bytes.fromhex("b001000000")))
    print(r[2:2 + r[1]].decode("ascii", "replace"))

elif cmd == "read":
    # Walk until the chip says the index is out of range rather than assuming
    # a count. This file is the fourth place that hardcoded three slots; the
    # persistence test reads through it, so a hardcoded three meant the claim
    # "NVRAM survived" was only ever checked for the first three envelopes.
    s = 0
    while True:
        try:
            r = bytes(d.exchange(bytes([0xE0, 0x10, s, 0, 0])))
            b, rs, sp, pc, av = struct.unpack(">QQQQQ", r[21:61])
            _, seq = struct.unpack(">II", r[61:69])
            print(f"slot{s} agent={r[1:21].hex()[:8]} spent={sp} budget={b} avail={av} draws={seq}")
        except CommException as e:
            if e.sw == 0xB108:                 # past the last slot
                break
            print(f"slot{s} " + ("free" if e.sw == 0xB102 else f"sw=0x{e.sw:04x}"))
        s += 1

elif cmd == "quit":
    # No reply comes back: the app is torn down mid-exchange.
    try:
        d.exchange(bytes([0xE0, 0x15, 0, 0, 0]))
    except Exception:
        pass
    print("quit issued")
