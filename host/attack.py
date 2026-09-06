#!/usr/bin/env python3
"""
The same attack, against both enforcement models.

Threat: an attacker has root on the machine running the agent. Not a
prompt-injected agent, not a bug in the policy — full control of the host.
This is not exotic; it is the assumption every hardware wallet is sold on.

    python3 host/attack.py software     # policy in a process on this host
    python3 host/attack.py device       # policy in the Secure Element

Both modes enforce the same rules. Only the location differs. That is the
whole experiment: one variable, and it is not the rules.
"""
import glob
import json
import os
import struct
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "software"))

ATTACKER = 66666666
BIG = 10_000_000_000  # 100 HBAR, far past any envelope we grant


def step(n, what):
    print(f"  [{n}/3] {what:.<52}", end=" ", flush=True)


def attack_software():
    import policy

    print("\nmode: software  — the policy engine runs in a process on this host\n")

    step(1, "locating the policy")
    if not os.path.exists(policy.STATE):
        print("nothing yet — run the agent first")
        return 1
    with open(policy.STATE) as f:
        state = json.load(f)
    slot = sorted(state["mandates"])[0]
    m = state["mandates"][slot]
    print("found")
    print(f"        {policy.STATE}")
    print(f"        budget {m['budget_total']/1e8:g} HBAR, "
          f"per-call {m['per_call_max']/1e8:g} HBAR, "
          f"may pay {m['payees']}")

    step(2, "raising the ceiling and adding my own account")
    m["budget_total"] = BIG
    m["per_call_max"] = BIG
    m["payees"].append(ATTACKER)
    with open(policy.STATE, "w") as f:
        json.dump(state, f, indent=2)
    print("done")

    step(3, f"paying {BIG/1e8:g} HBAR to 0.0.{ATTACKER}")
    store = policy.Store.load()
    try:
        seq, avail = store.authorize(int(slot), ATTACKER, BIG)
        print("SETTLED")
        print(f"\n  The budget was a number in a file I can write to.")
        print(f"  Draw #{seq} authorised. {avail/1e8:g} HBAR of 'budget' left.\n")
        return 0
    except policy.Refused as e:
        print(f"refused: {e.code}")
        return 1


def attack_device():
    from ledgerblue.commException import CommException
    from transport import open_device

    print("\nmode: device  — the policy lives in the Secure Element\n")

    step(1, "locating the policy")
    found = [p for p in glob.glob("/tmp/vela*") + glob.glob("./*.json") if os.path.isfile(p)]
    print("nothing to find")
    print("        the envelope is in NVRAM on the chip. There is no file,")
    print("        no environment variable, and no key on this host.")

    d = open_device()
    slot = 0

    step(2, "raising the ceiling")
    print("no such command")
    print("        the only instruction that writes a mandate is CREATE, and")
    print("        it does not return until someone holds a button on the device.")

    now = int(time.time())
    step(3, f"paying {BIG/1e8:g} HBAR to 0.0.{ATTACKER}")
    req = bytes([slot]) + struct.pack(
        ">QQQQQQIII", 10365982, ATTACKER, 3, BIG, 100_000_000, now, 0, 120, now)
    try:
        d.exchange(bytes([0xE0, 0x12, 0, 0, len(req)]) + req)
        print("SETTLED — this is a bug")
        return 1
    except CommException as e:
        codes = {0xB102: "not_found", 0xB104: "payee_not_allowed", 0xB106: "over_budget"}
        print(f"REFUSED ({codes.get(e.sw, hex(e.sw))})")

    print("\n  I have root on this machine and it changed nothing. The chip")
    print("  holds the ceiling and the allowlist, and it is the only thing")
    print("  that can produce the buyer's signature.\n")
    return 0


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "software"
    sys.exit(attack_software() if mode == "software" else attack_device())
