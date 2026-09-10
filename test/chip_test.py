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
GET, CREATE, AUTHORIZE, SETTLE, REVOKE, AUTH_CALL, GET_BODY, RESTORE = (
    0x10, 0x11, 0x12, 0x13, 0x14, 0x18, 0x19, 0x1A)

OK = 0x9000
SW = {
    OK: "AUTHORIZED", 0xB101: "no_slot", 0xB102: "not_found",
    0xB103: "expired", 0xB104: "payee_not_allowed", 0xB105: "over_per_call",
    0xB106: "over_budget", 0xB107: "settle_amount", 0xB108: "bad_request",
    0xB109: "contract_not_allowed", 0xB10A: "selector_not_allowed",
    0xB10B: "recipient_not_self", 0xB10C: "too_fast",
}

def _env(key, default):
    """
    Accounts come from .env, not from a constant here.

    Three separate bugs in this repository have been a Hedera account frozen
    into a file while the device's seed moved underneath it, and each one
    surfaced somewhere far from the constant.
    """
    import re
    root = Path(__file__).resolve().parent.parent
    try:
        m = re.search(rf"^{key}=0\.0\.(\d+)", (root / ".env").read_text(), re.M)
        return int(m.group(1)) if m else default
    except OSError:
        return default


PAYEE = _env("HEDERA_TREASURY_ID", 10_388_937)
SELF = _env("HEDERA_BUYER_ID", 10_397_072)
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


def slot_count():
    """Ask the chip how many slots it has.

    Walks until the device stops recognising the index. `not_found` means an
    empty slot that exists; anything else means it does not. Capped so a
    firmware that answers `not_found` to everything cannot spin here.
    """
    n = 0
    while n < 64:
        sw = send(GET, p1=n)[0]
        if sw not in (0xB102, OK):
            break
        n += 1
    return n


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
          contracts=(), selectors=(), recipient_arg=None, expect_screen=True,
          window_secs=0, max_per_window=0):
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
    if contracts or window_secs:
        body += bytes([len(contracts)]) + b"".join(struct.pack(">Q", c) for c in contracts)
        body += bytes([len(selectors)]) + b"".join(selectors)
        body += bytes([recipient_arg if recipient_arg is not None else 0xFF])
    if window_secs:
        body += struct.pack(">IH", window_secs, max_per_window)
    if ON_DEVICE:
        # A grant the chip rejects while parsing never reaches a screen, so
        # there is nothing to ask for and nothing to drive. Spawning the
        # emulator's approver here anyway printed a connection-refused
        # traceback into the middle of an otherwise passing hardware run.
        if expect_screen:
            print(f"      >>> approve '{label}' on the device <<<", flush=True)
        sw, r = send(CREATE, body, timeout=300 if expect_screen else 30)
    else:
        t = threading.Thread(target=lambda: (time.sleep(1.0), approve.approve()))
        t.start()
        sw, r = send(CREATE, body, timeout=60)
        t.join()
    return sw, (r[0] if r else None)


def restore(label, budget, per_call, seq, spent, tag=0xD4, payee=PAYEE,
            contracts=(), selectors=(), recipient_arg=None,
            window_secs=0, max_per_window=0):
    """Put an envelope back at the position the audit log says it reached."""
    if contracts:
        calls = (bytes([len(contracts)]) + b"".join(struct.pack(">Q", c) for c in contracts)
                 + bytes([len(selectors)]) + b"".join(selectors)
                 + bytes([recipient_arg if recipient_arg is not None else 0xFF]))
    else:
        calls = bytes([0, 0, 0xFF])
    # The velocity block is mandatory here even when empty: the position
    # follows it, and absent would be indistinguishable from six bytes of
    # sequence number.
    body = (bytes(20 * [tag])
            + bytes([1]) + struct.pack(">Q", payee)
            + struct.pack(">Q", budget) + struct.pack(">Q", per_call)
            + struct.pack(">I", 0)
            + bytes([len(label)]) + label.encode()
            + calls
            + struct.pack(">IH", window_secs, max_per_window)
            + struct.pack(">I", seq) + struct.pack(">Q", spent))
    if ON_DEVICE:
        print(f"      >>> approve the RESTORE of '{label}' on the device <<<", flush=True)
        sw, r = send(RESTORE, body, timeout=300)
    else:
        t = threading.Thread(target=lambda: (time.sleep(1.0), approve.approve()))
        t.start()
        sw, r = send(RESTORE, body, timeout=60)
        t.join()
    return sw, (r[0] if r else None)


def sections(state):
    """Where each variable-length part of a GET response starts.

    One walker rather than one per caller. This response has grown three times
    — contracts, then the label, then velocity — and every reader that stepped
    over the sections by hand had to be found and fixed each time. Two of them
    were, once, by a failing test; the third was the gateway, silently.
    """
    off = 70 + state[69] * 8
    contracts = off
    off += 1 + state[off] * 8
    selectors = off
    off += 1 + state[off] * 4
    recipient_arg = off
    off += 1
    velocity = off
    off += 12                      # window(4) cap(2) used(2) start(4)
    return {"contracts": contracts, "selectors": selectors,
            "recipient_arg": recipient_arg, "velocity": velocity, "label": off}


def label_of(state):
    off = sections(state)["label"]
    return state[off + 1:off + 1 + state[off]].decode()


def velocity_of(state):
    off = sections(state)["velocity"]
    window, cap, used, start = struct.unpack(">IHHI", state[off:off + 12])
    return window, cap, used, start


def position(slot):
    """(spent, available, seq) as the chip reports them."""
    sw, st = send(GET, p1=slot)
    if sw != OK:
        return None
    spent = int.from_bytes(st[37:45], "big")
    available = int.from_bytes(st[53:61], "big")
    seq = int.from_bytes(st[65:69], "big")
    return spent, available, seq


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
        # How many slots there are is the chip's answer, not a constant kept
        # in step by hand. MANDATE_COUNT went from three to eight and this
        # loop would have gone on testing the first three — passing, and
        # covering less than it said it did.
        slots = slot_count()
        free = [i for i in range(slots) if send(GET, p1=i)[0] == 0xB102]
        print(f"\nrunning against hardware — {len(free)} of {slots} slot(s) free, "
              f"3 approvals needed")
        if len(free) < 2:
            print("\n  This suite grants two mandates and needs two free slots.")
            print("  Revoke some on the device, or run `node hedera/fleet.mjs`")
            print("  afterwards to put the fleet back.\n")
            return 2
        globals()["SLOT_A"], globals()["SLOT_B"] = free[0], free[1]

    print("\nstorage")
    # The count itself, so growing MANDATE_COUNT cannot silently ship a build
    # whose extra slots nothing ever touches.
    n = slot_count()
    check("the chip reports eight slots", n, 8)
    check("and refuses an index past the last one", send(GET, p1=n)[0], 0xB108)
    check("an unused slot reports not_found", send(GET, p1=SLOT_A)[0], 0xB102)

    print("\ngranting")
    sw, slot = grant("research-1", 50_000_000, 10_000_000,
                     contracts=(ROUTER,), selectors=(SWAP,), recipient_arg=1)
    check("a mandate can be granted", sw, OK)

    sw, state = send(GET, p1=SLOT_A)
    check("and read back", sw, OK)
    if sw == OK:
        label = label_of(state)
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

    print("\nvelocity — how fast, not how much")
    # A budget bounds the total. It says nothing about the rate, and rate is
    # where an agent differs from a person: the envelope that survives forty
    # honest payments a night is the one a compromised agent drains in ninety
    # seconds.
    sw, vslot = grant("burst", 50_000_000, 10_000_000, tag=0xE1,
                      window_secs=3600, max_per_window=2)
    check("a mandate can carry a rate limit", sw, OK)
    # Published, so an agent can plan against it. A ceiling discovered by
    # hitting it is a trap; the chip refuses either way, and telling the agent
    # in advance costs nothing.
    sw_v, st_v = send(GET, p1=vslot)
    if sw_v == OK:
        window, cap, used, _ = velocity_of(st_v)
        check("and the chip publishes it",
              OK if (window, cap, used) == (3600, 2, 0) else 0xB108, OK)
    if sw == OK:
        t0 = 1_800_000_000
        check("the first draw in the window passes",
              draw(vslot, PAYEE, 1_000_000, now=t0), OK)
        check("and the second", draw(vslot, PAYEE, 1_000_000, now=t0 + 10), OK)
        check("the third is refused, with budget still left",
              draw(vslot, PAYEE, 1_000_000, now=t0 + 20), 0xB10C)
        check("a refused draw does not consume the window",
              draw(vslot, PAYEE, 1_000_000, now=t0 + 30), 0xB10C)
        check("the next window allows draws again",
              draw(vslot, PAYEE, 1_000_000, now=t0 + 3600), OK)
        # No clock in the chip: `now` is the host's word. Forwards only ever
        # resets a counter the host could have waited out; backwards is the
        # one lie this can catch without a clock of its own.
        check("a host that winds the clock back is refused",
              draw(vslot, PAYEE, 1_000_000, now=t0 + 100), 0xB10C)
        revoke(vslot)
    check("half a rate limit is refused at grant time",
          grant("halflimit", 50_000_000, 10_000_000, tag=0xE2,
                window_secs=3600, max_per_window=0, expect_screen=False)[0],
          0xB108)

    print("\nrecovery — the device is replaced, the envelope is not")
    # A restored envelope that started at zero would let its agent spend the
    # whole budget a second time, which is the only way this feature can be
    # dangerous rather than merely absent.
    sw, rslot = restore("restored-1", 50_000_000, 10_000_000, seq=7, spent=38_000_000)
    check("a mandate can be restored at a position", sw, OK)
    if sw == OK:
        pos = position(rslot)
        check("the spend it had already made survives",
              OK if pos and pos[0] == 38_000_000 else 0xB108, OK)
        check("so only the remainder is available",
              OK if pos and pos[1] == 12_000_000 else 0xB108, OK)
        check("and the sequence continues rather than restarting",
              OK if pos and pos[2] == 7 else 0xB108, OK)
        check("a draw inside what is left is authorised",
              draw(rslot, PAYEE, 10_000_000), OK)
        # Settle takes what was quoted and what was actually spent. Settling
        # the full quote here matters: it leaves nothing reserved, so the
        # refusal below has to come from the restored position rather than
        # from a reservation still being held.
        check("settling it moves the counter on",
              send(SETTLE, bytes([rslot]) + struct.pack(">QQ", 10_000_000, 10_000_000))[0], OK)
        after = position(rslot)
        check("48 of 50 HBAR are now spent",
              OK if after and after[0] == 48_000_000 else 0xB108, OK)
        check("and a draw past the restored remainder is refused",
              draw(rslot, PAYEE, 10_000_000), 0xB106)
        revoke(rslot)
    # A restore that dropped the contract terms would match the audit log's
    # digest perfectly and hand back an agent that can no longer trade. The
    # digest does not cover these fields, so nothing else would catch it.
    sw, cslot = restore("restored-defi", 50_000_000, 10_000_000, seq=3, spent=1_000_000,
                        tag=0xD5, contracts=(ROUTER,), selectors=(SWAP,), recipient_arg=1)
    check("a restored mandate keeps the right to trade", sw, OK)
    if sw == OK:
        check("and the swap it was granted still passes",
              call(cslot, ROUTER, SWAP + word(1_000_000) + word(SELF)), OK)
        check("while the same swap to an attacker is still refused",
              call(cslot, ROUTER, SWAP + word(1_000_000) + word(ATTACKER)), 0xB10B)
        revoke(cslot)

    # The velocity block is mandatory on a restore because the position
    # follows it. A body that omits it hands the parser six bytes of sequence
    # number where it expects a window, and the refusal must be a refusal
    # rather than a mandate restored to a position nobody asked for.
    short = (bytes(20 * [0xD6])
             + bytes([1]) + struct.pack(">Q", PAYEE)
             + struct.pack(">QQ", 50_000_000, 10_000_000)
             + struct.pack(">I", 0)
             + bytes([5]) + b"short"
             + bytes([0, 0, 0xFF])
             + struct.pack(">I", 3) + struct.pack(">Q", 1_000_000))
    check("a restore without the velocity block is refused, not misread",
          send(RESTORE, short, timeout=20)[0], 0xB108)

    # The spend position survives a restore and the rate window does not.
    # Deliberate: a window counts against wall-clock time, and a restore
    # happens at a moment the chip cannot know, so carrying a count from a
    # window that may have closed hours ago enforces a limit against a period
    # that no longer exists. It is not a silent bypass — restoring needs a
    # person approving a screen that names the position.
    sw, rl = restore("restored-rate", 50_000_000, 10_000_000, seq=6,
                     spent=20_000_000, tag=0xD7,
                     window_secs=3600, max_per_window=2)
    check("a rate limit survives a restore", sw, OK)
    if sw == OK:
        _, st_rl = send(GET, p1=rl)
        window, cap, used, start = velocity_of(st_rl)
        check("the terms come back", OK if (window, cap) == (3600, 2) else 0xB108, OK)
        check("the window itself restarts",
              OK if (used, start) == (0, 0) else 0xB108, OK)
        check("so draws are allowed again",
              draw(rl, PAYEE, 1_000_000, now=1_800_000_000), OK)
        revoke(rl)

    check("a restore claiming more spent than the budget is refused",
          restore("liar", 50_000_000, 10_000_000, seq=1, spent=60_000_000)[0],
          0xB108)

    print("\nrevocation")
    check("a slot can be revoked", revoke(SLOT_A), OK)
    check("and reads as free afterwards", send(GET, p1=SLOT_A)[0], 0xB102)

    failed = [r for r in results if not r[0]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
