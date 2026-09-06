#!/usr/bin/env python3
"""
Vela host CLI — drives the mandate surface over USB.

The device is the only thing that decides. This script asks; it never
enforces. Every refusal you see here was decided inside the Secure Element,
and no flag on this side can change that outcome.

Usage:
    python3 host/vela.py demo          # grant, draw, settle, refuse — end to end
    python3 host/vela.py list
    python3 host/vela.py revoke <id>
"""
import hashlib
import struct
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import time

from transport import open_device
from ledgerblue.commException import CommException

CLA = 0xE0
INS_GET_MANDATE = 0x10
INS_CREATE_MANDATE = 0x11
INS_AUTHORIZE_SPEND = 0x12
INS_SETTLE_CONFIRM = 0x13
INS_REVOKE_MANDATE = 0x14
INS_QUIT_APP = 0x15
INS_GET_PUBKEY = 0x16

# Testnet accounts from the Blocky402 spike; the payer is ours.
PAYER = 10365982
PAYEE = 10365984
NODE = 3

TINYBAR = 100_000_000  # 1 HBAR

# Why the chip said no. Each one is actionable: the agent can correct itself
# instead of retry-looping against a wall.
REFUSALS = {
    0xB101: ("no_slot", "every mandate slot is occupied"),
    0xB102: ("not_found", "no mandate in that slot"),
    0xB103: ("expired", "the envelope has expired"),
    0xB104: ("payee_not_allowed", "payee is not on the allowlist"),
    0xB105: ("over_per_call", "over the per-call ceiling"),
    0xB106: ("over_budget", "over what is left in the envelope"),
    0xB107: ("bad_settle_amount", "settling more than was authorised"),
    0xB108: ("bad_request", "malformed request"),
    0x6985: ("user_declined", "refused on the device"),
}


def agent_id(name: str) -> bytes:
    return hashlib.sha256(name.encode()).digest()[:20]


def hbar(tinybars: int) -> str:
    return f"{tinybars / TINYBAR:.8f}".rstrip("0").rstrip(".") or "0"


class Device:
    def __init__(self):
        self.dongle = open_device()

    def send(self, ins: int, data: bytes = b"", p1: int = 0, p2: int = 0) -> bytes:
        apdu = bytes([CLA, ins, p1, p2, len(data)]) + data
        return self.dongle.exchange(apdu)

    def create_mandate(self, agent: str, payees, budget, per_call, expiry=0) -> int:
        data = agent_id(agent) + bytes([len(payees)])
        data += b"".join(struct.pack(">Q", p) for p in payees)
        data += struct.pack(">QQI", budget, per_call, expiry)
        return self.send(INS_CREATE_MANDATE, data)[0]

    def pubkey(self, index: int = 0) -> bytes:
        return self.send(INS_GET_PUBKEY, p1=index)

    def authorize(self, slot: int, payee: int, amount: int, payer=PAYER,
                  node=NODE, fee=100_000_000, now=None):
        """Ask the chip to authorise and sign one transfer."""
        now = int(time.time()) if now is None else now
        data = bytes([slot]) + struct.pack(
            ">QQQQQQIII", payer, payee, node, amount, fee, now, 0, 120, now)
        r = self.send(INS_AUTHORIZE_SPEND, data)
        seq, available = struct.unpack(">IQ", r[:12])
        body_len = r[12]
        body = r[13:13 + body_len]
        sig = r[13 + body_len:13 + body_len + 64]
        return seq, available, body, sig

    def settle(self, slot: int, quoted: int, actual: int):
        data = bytes([slot]) + struct.pack(">QQ", quoted, actual)
        spent, available = struct.unpack(">QQ", self.send(INS_SETTLE_CONFIRM, data))
        return spent, available

    def get(self, slot: int):
        r = self.send(INS_GET_MANDATE, p1=slot)
        in_use = r[0]
        agent = r[1:21]
        budget, reserved, spent, per_call, available = struct.unpack(">QQQQQ", r[21:61])
        expiry, seq = struct.unpack(">II", r[61:69])
        return dict(in_use=in_use, agent=agent.hex()[:8], budget=budget, reserved=reserved,
                    spent=spent, per_call=per_call, available=available, expiry=expiry, seq=seq)

    def revoke(self, slot: int):
        self.send(INS_REVOKE_MANDATE, bytes([slot]))


def explain(e: CommException) -> str:
    name, why = REFUSALS.get(e.sw, ("unknown", f"status 0x{e.sw:04x}"))
    return f"REFUSED [{name}] {why}"


def cmd_list(dev: Device):
    for slot in range(3):
        try:
            m = dev.get(slot)
        except CommException as e:
            print(f"  slot {slot}: {'free' if e.sw == 0xB102 else explain(e)}")
            continue
        print(f"  slot {slot}: agent {m['agent']}  "
              f"{hbar(m['available'])}/{hbar(m['budget'])} HBAR left  "
              f"reserved {hbar(m['reserved'])}  spent {hbar(m['spent'])}  draws {m['seq']}")


def cmd_demo(dev: Device):
    print("\n1. Granting a mandate — approve it on the device.")
    print("   agent 'analyst', 1 HBAR total, 0.2 HBAR max per draw,")
    print("   may pay: account 0.0." + str(PAYEE) + "\n")
    slot = dev.create_mandate("analyst", [PAYEE],
                              budget=1 * TINYBAR, per_call=TINYBAR // 5)
    print(f"   granted in slot {slot}\n")

    print("2. Drawing against it — no tap, that is what the mandate authorised.")
    for i in range(3):
        seq, available, body, sig = dev.authorize(slot, PAYEE, TINYBAR // 10)
        print(f"   draw {seq}: 0.1 HBAR, {hbar(available)} HBAR left on chip, "
              f"{len(body)}-byte body signed on device")
        dev.settle(slot, TINYBAR // 10, TINYBAR // 10)

    print("\n3. Now the refusals. Each one is decided inside the chip.\n")

    print("   a) an account that is not on the allowlist")
    try:
        dev.authorize(slot, 99999999, TINYBAR // 100)
        print("      !! it went through — that is a bug")
    except CommException as e:
        print(f"      {explain(e)}")

    print("   b) a draw above the per-call ceiling")
    try:
        dev.authorize(slot, PAYEE, TINYBAR // 2)
        print("      !! it went through — that is a bug")
    except CommException as e:
        print(f"      {explain(e)}")

    print("   c) draining what is left, one legal draw at a time")
    drained = 0
    while True:
        try:
            seq, available, _, _ = dev.authorize(slot, PAYEE, TINYBAR // 10)
            dev.settle(slot, TINYBAR // 10, TINYBAR // 10)
            drained += 1
        except CommException as e:
            print(f"      after {drained} more draws: {explain(e)}")
            break

    print("\n4. Final state, read back from NVRAM:")
    cmd_list(dev)
    print("\n   These numbers survive a reboot, a redeploy, and root on this host.")
    print("   Nothing on this side can move them.\n")


def main():
    args = sys.argv[1:] or ["demo"]
    try:
        dev = Device()
    except Exception as e:
        print(f"cannot reach the device: {e}")
        print("open the Vela app on the Ledger first")
        return 1

    if args[0] == "demo":
        cmd_demo(dev)
    elif args[0] == "list":
        cmd_list(dev)
    elif args[0] == "revoke":
        dev.revoke(int(args[1]))
        print("revoked")
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
