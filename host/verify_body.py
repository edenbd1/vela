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
import struct
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from transport import open_device
from ledgerblue.commException import CommException

CLA = 0xE0
INS_AUTHORIZE, INS_PUBKEY, INS_SETTLE = 0x12, 0x16, 0x13


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
    # The alarm lives here, not at import time: verify_body is imported by
    # e2e.py for its decoder, and a module-level alarm would kill its caller.
    import signal
    signal.signal(signal.SIGALRM, lambda *a: (print("TIMEOUT"), sys.exit(2)))
    signal.alarm(60)

    # From the environment, like every other tool here. These were hardcoded
    # to accounts from an early testnet run, so this check verified that the
    # chip signed a transfer between two accounts nobody uses.
    payer = int(os.environ.get("HEDERA_BUYER_ID", "0.0.10397072").split(".")[-1])
    payee = int(os.environ.get("HEDERA_TREASURY_ID", "0.0.10388937").split(".")[-1])
    fee_payer, node = 7_162_784, 3          # the Blocky402 facilitator
    amount = 1_000_000  # 0.01 HBAR in tinybars
    slot = int(sys.argv[1]) if len(sys.argv) > 1 else 0

    d = open_device()

    # Use whatever mandate already occupies the slot. Granting one needs a
    # human, or the emulator's approval walker; neither belongs in a check
    # that is about what gets signed.
    pk = bytes(d.exchange(bytes([CLA, INS_PUBKEY, 0, 0, 0])))
    print(f"device key   : {pk.hex()}")

    # Seven u64 and three u32. The fee payer at the front arrived with x402 —
    # the facilitator pays the Hedera fee, the buyer pays the seller — and
    # this file never grew it, so every request it made came back 0xb108
    # bad_request. Nothing referenced it and no suite ran it, so the one check
    # that asks whether the chip signs what it was asked to sign had been
    # broken for as long as the field has existed.
    now = int(time.time())
    req = bytes([slot]) + struct.pack(
        ">QQQQQQQIII", fee_payer, payer, payee, node, amount, 100_000_000, now, 0, 120, now
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

    # The chip's own statement about this draw, and its signature over it.
    # Needed below to give the sequence number back to the log.
    at = 13 + body_len + 64
    chip_anchor = r[at:at + 29]
    chip_anchor_sig = r[at + 29:at + 93]

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

    # The transaction id names the *fee payer*, not the buyer. Under x402 the
    # facilitator pays Hedera's fee while the buyer pays the seller, so those
    # are two different accounts and the id carries the first. This asserted
    # the buyer and reported a mismatch against a device that was correct —
    # a check wrong in the direction that accuses the chip is worse than no
    # check, because it is the chip nobody can inspect.
    txid = get(body, 1)
    named = account_num(get(txid, 2))
    if named != fee_payer:
        print(f"  MISMATCH — transaction id names {named}, not the fee payer")
        ok = False
    else:
        print(f"  the transaction id names the fee payer 0.0.{named}, "
              f"and the buyer is debited in the legs")
    if account_num(get(body, 2)) != node:
        print("  MISMATCH — wrong node account")
        ok = False

    try:
        Ed25519PublicKey.from_public_bytes(pk).verify(sig, body)
        print("  signature verifies under the device's own key")
    except InvalidSignature:
        print("  SIGNATURE DOES NOT VERIFY")
        ok = False

    # Give it back — the money and the number.
    #
    # This asks the chip to authorise a real draw, which burns a sequence
    # number whether or not anything is paid. Settling to zero returns the
    # budget; only publishing a release returns the position. Skip the second
    # half and this check leaves the log ending before the chip does, which
    # verify.mjs cannot see — a hole at the end of a chain has nothing after
    # it to be discontinuous with — and which breaks the next draw that is
    # published. It did exactly that twice before this was written.
    release = bytes([slot]) + struct.pack(">QQ", amount, 0)
    d2 = open_device()
    try:
        d2.exchange(bytes([CLA, INS_SETTLE, 0, 0, len(release)]) + release)
        print("  reservation settled to zero — the budget is back")
    finally:
        d2.close()

    published = subprocess.run(
        ["node", os.path.join(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__))), "hedera", "publish-release.mjs"),
         str(slot), str(seq), str(payee), str(amount), str(available),
         chip_anchor.hex(), chip_anchor_sig.hex()],
        capture_output=True, text=True)
    line = (published.stdout or published.stderr).strip().splitlines()
    print(f"  {line[-1]}" if line else "  the release was not published")

    print()
    print("The chip built these bytes and signed them. The host never held a"
          if ok else "Something is wrong.")
    if ok:
        print("key that could have produced this signature.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
