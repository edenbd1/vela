#!/usr/bin/env python3
"""
Check what the chip actually signed.

Ask for a draw, then take the body the device returned, decode it as Hedera
protobuf, and confirm three things:

  - the transfer credits the account we asked for, and debits ours
  - the amount is the one the mandate cleared
  - the signature verifies under the key the device derived

If any of those fail, the device is signing something other than what it
was asked to authorise, which is the one bug this project cannot survive.
"""
import signal
import struct
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

signal.signal(signal.SIGALRM, lambda *a: (print("TIMEOUT"), sys.exit(2)))
signal.alarm(30)

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from transport import open_device
from ledgerblue.commException import CommException

CLA = 0xE0
INS_AUTHORIZE, INS_PUBKEY = 0x12, 0x16


# --- a protobuf reader, only as much as we need ----------------------------
def varint(b, i):
    v, shift = 0, 0
    while True:
        x = b[i]
        i += 1
        v |= (x & 0x7F) << shift
        if not x & 0x80:
            return v, i
        shift += 7


def fields(b):
    """Yield (field_number, wire_type, value) for one message."""
    i = 0
    while i < len(b):
        tag, i = varint(b, i)
        fn, wt = tag >> 3, tag & 7
        if wt == 0:
            v, i = varint(b, i)
            yield fn, wt, v
        elif wt == 2:
            n, i = varint(b, i)
            yield fn, wt, b[i:i + n]
            i += n
        else:
            raise ValueError(f"unexpected wire type {wt}")


def get(b, fn):
    for f, _, v in fields(b):
        if f == fn:
            return v
    return None


def get_all(b, fn):
    return [v for f, _, v in fields(b) if f == fn]


def unzigzag(v):
    return (v >> 1) ^ -(v & 1)


def account_num(msg):
    """AccountID: shard 1, realm 2, accountNum 3. Zeros are omitted."""
    n = get(msg, 3)
    return n if n is not None else 0


def decode_transfer(body):
    """Pull the legs out of TransactionBody.cryptoTransfer.transfers."""
    ct = get(body, 14)
    if ct is None:
        raise ValueError("no cryptoTransfer in the body")
    tl = get(ct, 1)
    legs = []
    for aa in get_all(tl, 1):
        acct = account_num(get(aa, 1))
        raw = get(aa, 2)
        legs.append((acct, unzigzag(raw if raw is not None else 0)))
    return legs


def main():
    payer, payee, node = 10365982, 10365984, 3
    amount = 1_000_000  # 0.01 HBAR in tinybars
    slot = int(sys.argv[1]) if len(sys.argv) > 1 else 1

    d = open_device()

    # Grant a fresh envelope on the chosen slot, so the check does not depend
    # on whatever a previous run left behind. Needs a tap.
    import hashlib
    agent = hashlib.sha256(b"verifier").digest()[:20]
    grant = agent + bytes([1]) + struct.pack(">Q", payee)
    grant += struct.pack(">QQI", 10_000_000, 5_000_000, 0)
    try:
        got = bytes(d.exchange(bytes([CLA, 0x11, 0, 0, len(grant)]) + grant))
        slot = got[0]
        print(f"granted a fresh mandate in slot {slot}")
    except CommException as e:
        print(f"could not grant: 0x{e.sw:04x}")
        return 1

    pk = bytes(d.exchange(bytes([CLA, INS_PUBKEY, 0, 0, 0])))
    print(f"device key   : {pk.hex()}")

    req = bytes([slot]) + struct.pack(
        ">QQQQQQIII", payer, payee, node, amount, 100_000_000, 1788539653, 0, 120, 1788539653
    )
    try:
        r = bytes(d.exchange(bytes([CLA, INS_AUTHORIZE, 0, 0, len(req)]) + req))
    except CommException as e:
        print(f"refused: 0x{e.sw:04x}")
        return 1
    finally:
        d.close()

    seq, available = struct.unpack(">IQ", r[:12])
    body_len = r[12]
    body = r[13:13 + body_len]
    sig = r[13 + body_len:13 + body_len + 64]

    print(f"draw #{seq}, {available/1e8:g} HBAR left on chip")
    print(f"body         : {body_len} bytes  {body.hex()}")
    print(f"signature    : {sig.hex()}")

    ok = True

    legs = decode_transfer(body)
    print(f"\ntransfer legs: {legs}")
    want = sorted([(payer, -amount), (payee, amount)])
    if sorted(legs) != want:
        print(f"  MISMATCH — expected {want}")
        ok = False
    else:
        print("  legs match the request, and sum to zero")

    txid = get(body, 1)
    if account_num(get(txid, 2)) != payer:
        print("  MISMATCH — transaction id names a different payer")
        ok = False
    if account_num(get(body, 2)) != node:
        print("  MISMATCH — wrong node account")
        ok = False

    try:
        Ed25519PublicKey.from_public_bytes(pk).verify(sig, body)
        print("  signature verifies under the device's own key")
    except InvalidSignature:
        print("  SIGNATURE DOES NOT VERIFY")
        ok = False

    print()
    print("The chip built these bytes and signed them. The host never held a"
          if ok else "Something is wrong.")
    if ok:
        print("key that could have produced this signature.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
