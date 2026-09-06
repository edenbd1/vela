#!/usr/bin/env python3
"""
End to end, against the emulator: grant, draw, and check what was signed.

The point of the last step is narrow and important. The device returns a
transaction body it built itself. We decode it as Hedera protobuf and
confirm the transfer credits the account the mandate allowed, debits ours,
carries the amount that was cleared, and verifies under the device's own
key. If any of that fails, the chip is signing something other than what it
authorised — the one bug this design cannot survive.

    VELA_SPECULOS=1 python3 host/e2e.py
"""
import hashlib
import os
import struct
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from ledgerblue.commException import CommException

import approve
import screen
from transport import open_device
from verify_body import decode_transfer, account_num, get

CLA = 0xE0
INS_CREATE, INS_AUTHORIZE, INS_PUBKEY, INS_GET = 0x11, 0x12, 0x16, 0x10

PAYER, PAYEE, NODE = 10365982, 10365984, 3
TINYBAR = 100_000_000


def grant(d, budget, per_call, payees):
    """Send CREATE_MANDATE and walk the review at the same time.

    Takes the connection rather than opening its own: Speculos exits when an
    APDU client disconnects, so a second short-lived connection takes the
    emulator down with it — and the symptom is an "app crash" on whatever
    command happens to come next.
    """
    out = {}

    def send():
        agent = hashlib.sha256(b"analyst").digest()[:20]
        data = agent + bytes([len(payees)])
        data += b"".join(struct.pack(">Q", p) for p in payees)
        data += struct.pack(">QQI", budget, per_call, 0)
        try:
            out["r"] = bytes(d.exchange(bytes([CLA, INS_CREATE, 0, 0, len(data)]) + data))
        except CommException as e:
            out["sw"] = e.sw

    screen.clear()
    t = threading.Thread(target=send, daemon=True)
    t.start()
    pages = approve.approve(verbose=True)
    t.join(timeout=15)
    # The status screen sits for a moment before the app returns home.
    time.sleep(2.5)
    screen.clear()
    if "r" not in out:
        raise RuntimeError(f"grant failed: 0x{out.get('sw', 0):04x}")
    return out["r"][0], pages


def main():
    d = open_device()

    print("1. Granting an envelope. These are the words a user reads:\n")
    slot, _ = grant(d, TINYBAR, TINYBAR // 5, [PAYEE])
    print(f"\n   granted in slot {slot}\n")

    pk = bytes(d.exchange(bytes([CLA, INS_PUBKEY, 0, 0, 0])))
    print(f"2. The device's own key: {pk.hex()}\n")

    amount = TINYBAR // 10
    now = 1788539653
    req = bytes([slot]) + struct.pack(
        ">QQQQQQIII", PAYER, PAYEE, NODE, amount, TINYBAR, now, 0, 120, now)
    r = bytes(d.exchange(bytes([CLA, INS_AUTHORIZE, 0, 0, len(req)]) + req))
    d.close()

    seq, available = struct.unpack(">IQ", r[:12])
    blen = r[12]
    body, sig = r[13:13 + blen], r[13 + blen:13 + blen + 64]
    print(f"3. Draw #{seq} authorised, {available / TINYBAR:g} HBAR left on chip")
    print(f"   body ({blen} bytes): {body.hex()}")
    print(f"   signature: {sig.hex()[:32]}...\n")

    ok = True
    legs = sorted(decode_transfer(body))
    want = sorted([(PAYER, -amount), (PAYEE, amount)])
    print(f"4. Decoded transfer: {legs}")
    if legs != want:
        print(f"   MISMATCH — expected {want}")
        ok = False
    else:
        print("   credits the allowed account, debits ours, sums to zero")

    if account_num(get(body, 2)) != NODE:
        print("   MISMATCH — wrong node account")
        ok = False

    try:
        Ed25519PublicKey.from_public_bytes(pk).verify(sig, body)
        print("   signature verifies under the device's own key\n")
    except InvalidSignature:
        print("   SIGNATURE DOES NOT VERIFY\n")
        ok = False

    if ok:
        print("The chip built these bytes and signed them. There is no key on")
        print("this host that could have produced that signature.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
