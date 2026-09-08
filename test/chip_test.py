"""
What the chip actually enforces.

Run against Speculos, because these are protocol assertions and the emulator
runs the same ELF — and because a suite that needs a person to tap five times
is a suite nobody runs. Two things it deliberately does not cover:

  persistence   whether NVRAM survives a restart is the one claim that cannot
                be taken on faith from an emulator. scripts/persistence-test.sh
                does it on the Flex.
  signatures    Speculos signs correctly for a key that owns nothing, so
                anything about real settlement belongs on hardware.

    ./scripts/test.sh
"""
import struct
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "host"))
import transport                           # noqa: E402
from transport import open_device          # noqa: E402
import approve                             # noqa: E402

# On the emulator this suite drives the screen itself. On hardware it cannot,
# and should not pretend to: it asks, and waits as long as the device does.
ON_DEVICE = transport.where() != "speculos"

CLA = 0xE0
GET, CREATE, AUTHORIZE, SETTLE, REVOKE, AUTH_CALL, GET_BODY = (
    0x10, 0x11, 0x12, 0x13, 0x14, 0x18, 0x19)

OK = 0x9000
SW = {
    OK: "AUTHORIZED", 0xB101: "no_slot", 0xB102: "not_found",
    0xB103: "expired", 0xB104: "payee_not_allowed", 0xB105: "over_per_call",
    0xB106: "over_budget", 0xB107: "settle_amount", 0xB108: "bad_request",
    0xB109: "contract_not_allowed", 0xB10A: "selector_not_allowed",
    0xB10B: "recipient_not_self",
}

PAYEE = 10_388_937
SELF = 10_397_072
ATTACKER = 66_666_666
ROUTER = 5_000_001
OTHER_ROUTER = 5_000_002
SWAP = bytes.fromhex("f406a91a")        # swapExactHBARForTokens(uint256,address)
APPROVE_SEL = bytes.fromhex("095ea7b3")  # approve(address,uint256)

results = []
d = None

# Which slots this suite may use. On the emulator storage is empty and they
# are 0 and 1; on hardware they are whichever are free, so running the tests
# does not quietly evict a live agent.
SLOT_A = 0
SLOT_B = 1


def check(name, got, want):
    ok = got == want
    results.append((ok, name, SW.get(got, hex(got)), SW.get(want, hex(want))))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}"
          f"{'' if ok else f'   got {SW.get(got, hex(got))}, want {SW.get(want, hex(want))}'}")
    return ok


def send(ins, body=b"", p1=0, timeout=30):
    """Returns (sw, data). A refusal is an answer here, not an exception."""
    try:
        r = d.exchange(bytes([CLA, ins, p1, 0, len(body)]) + body, timeout=timeout)
        return OK, bytes(r)
    except Exception as e:
        sw = getattr(e, "sw", None)
        if sw is None:
            raise
        return sw, getattr(e, "data", b"") or b""


def grant(label, budget, per_call, expiry=0, tag=0xA1, payee=PAYEE,
          contracts=(), selectors=(), recipient_arg=None, expect_screen=True):
    """
    `expect_screen=False` for grants the chip rejects before it draws
    anything. Asking someone to approve a screen that never appears is worse
    than asking nothing: they stand there waiting, then start pressing things.
    """
    body = (bytes(20 * [tag])
            + bytes([1]) + struct.pack(">Q", payee)
            + struct.pack(">Q", budget) + struct.pack(">Q", per_call)
            + struct.pack(">I", expiry)
            + bytes([len(label)]) + label.encode())
    if contracts:
        body += bytes([len(contracts)]) + b"".join(struct.pack(">Q", c) for c in contracts)
        body += bytes([len(selectors)]) + b"".join(selectors)
        body += bytes([recipient_arg if recipient_arg is not None else 0xFF])
    if ON_DEVICE and expect_screen:
        print(f"      >>> approve '{label}' on the device <<<", flush=True)
        sw, r = send(CREATE, body, timeout=300)
    else:
        t = threading.Thread(target=lambda: (time.sleep(1.0), approve.approve()))
        t.start()
        sw, r = send(CREATE, body, timeout=60)
        t.join()
    return sw, (r[0] if r else None)


def draw(slot, payee, amount, now=None):
    now = now or int(time.time())
    body = bytes([slot]) + struct.pack(
        ">QQQQQQQIII", 7162784, SELF, payee, 3, amount, 100_000_000, now, 0, 120, now)
    return send(AUTHORIZE, body)[0]


def call(slot, contract, calldata, amount=1_000_000):
    now = int(time.time())
    head = (bytes([slot]) + struct.pack(">QQQQQQQQ", 7162784, SELF, contract, 3,
                                        amount, 100_000_000, 120_000, now)
            + struct.pack(">III", 0, 120, now) + struct.pack(">H", len(calldata)))
    return send(AUTH_CALL, head + calldata)[0]


def word(n):
    b = bytearray(32)
    b[24:32] = struct.pack(">Q", n)
    return bytes(b)


def revoke(slot):
    if ON_DEVICE:
        print(f"      >>> approve the revoke of slot {slot} on the device <<<", flush=True)
        return send(REVOKE, bytes([slot]), timeout=300)[0]
    t = threading.Thread(target=lambda: (time.sleep(1.0), approve.tap_choice()))
    t.start()
    sw = send(REVOKE, bytes([slot]), timeout=60)[0]
    t.join()
    return sw


# ---------------------------------------------------------------------------

def main():
    global d
    d = open_device()

    # A device that is not answering is not a failing assertion, and reporting
    # it as one would be the suite lying about what it checked.
    try:
        send(GET, p1=0)
    except transport.DeviceUnreachable as e:
        print(f"\n  the device is not answering: {e}")
        print("  open the Vela app on the Flex and try again.\n")
        return 2

    if ON_DEVICE:
        free = [i for i in range(3) if send(GET, p1=i)[0] == 0xB102]
        print(f"\nrunning against hardware — {len(free)} free slot(s), "
              f"3 approvals needed")
        if len(free) < 2:
            print("\n  This suite grants two mandates and needs two free slots.")
            print("  Revoke some on the device, or run `node hedera/fleet.mjs`")
            print("  afterwards to put the fleet back.\n")
            return 2
        globals()["SLOT_A"], globals()["SLOT_B"] = free[0], free[1]

    print("\nempty storage")
    check("an unused slot reports not_found", send(GET, p1=SLOT_A)[0], 0xB102)

    print("\ngranting")
    sw, slot = grant("research-1", 50_000_000, 10_000_000,
                     contracts=(ROUTER,), selectors=(SWAP,), recipient_arg=1)
    check("a mandate can be granted", sw, OK)

    sw, state = send(GET, p1=SLOT_A)
    check("and read back", sw, OK)
    if sw == OK:
        label_off = 70 + state[69] * 8
        label_off += 1 + state[label_off] * 8
        label_off += 1 + state[label_off] * 4
        label_off += 1
        label = state[label_off + 1:label_off + 1 + state[label_off]].decode()
        check("with the label the human chose",
              OK if label == "research-1" else 0xB108, OK)

    print("\nrefusals on a transfer")
    check("a payee not on the allowlist", draw(SLOT_A, ATTACKER, 1_000_000), 0xB104)
    check("more than the per-draw ceiling", draw(SLOT_A, PAYEE, 50_000_000), 0xB105)

    print("\nrefusals on a contract call")
    check("a swap whose proceeds return here",
          call(SLOT_A, ROUTER, SWAP + word(1) + word(SELF)), OK)
    check("the same swap, proceeds to an attacker",
          call(SLOT_A, ROUTER, SWAP + word(1) + word(ATTACKER)), 0xB10B)
    check("approve() on the allowed router",
          call(SLOT_A, ROUTER, APPROVE_SEL + word(ATTACKER) + word(1)), 0xB10A)
    check("the same swap on a router never granted",
          call(SLOT_A, OTHER_ROUTER, SWAP + word(1) + word(SELF)), 0xB109)

    print("\nsettlement")
    # The successful call above reserved per_call_max; give it back.
    check("settling releases the reservation",
          send(SETTLE, bytes([SLOT_A]) + struct.pack(">QQ", 1_000_000, 0))[0], OK)
    check("settling more than was authorised",
          send(SETTLE, bytes([SLOT_A]) + struct.pack(">QQ", 1_000_000, 9_000_000))[0], 0xB107)

    print("\nexpiry — the branch nothing had ever taken")
    sw, _ = grant("short-lived", 10_000_000, 5_000_000,
                  expiry=int(time.time()) - 60, tag=0xD4)
    check("a mandate with an expiry can be granted", sw, OK)
    check("and every draw on it is refused", draw(SLOT_B, PAYEE, 1_000_000), 0xB103)

    print("\nvalidation")
    # No screen: the handler validates the label before it asks anyone.
    sw, _ = grant("bad\x01label", 10_000_000, 1_000_000, tag=0xE5,
                  expect_screen=False)
    check("a label with control characters is refused", sw, 0xB108)

    if ON_DEVICE:
        print("\n      >>> approve the revoke of the expired mandate <<<")
        revoke(SLOT_B)

    print("\nrevocation")
    check("a slot can be revoked", revoke(SLOT_A), OK)
    check("and reads as free afterwards", send(GET, p1=SLOT_A)[0], 0xB102)

    failed = [r for r in results if not r[0]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
