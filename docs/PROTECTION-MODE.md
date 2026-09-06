# Investigation — what put the Flex into protection mode

Three factory resets in two days. Ledger's
[E6 article](https://support.ledger.com/article/8632894981149-zd) says the
device enters protection mode "whenever your Ledger interprets an event as an
attack", and admits false positives. **It does not say which event.**

This note exists so the next occurrence produces evidence instead of another
guess. Two mechanisms have already been asserted confidently here and both
were wrong; see the end.

---

## What we did, repeatedly

Reconstructed from the session. All of it is ordinary BOLOS development.

| action | roughly how many | notable |
|---|---|---|
| `ledgerblue.loadApp` | ~10 over two days | prints `Generated random root public key` **and a different key every time**, then `Broken certificate chain - loading from user key` |
| `ledgerblue.deleteApp` | ~6 | interleaved with the loads |
| `ledgerblue.runApp` | ~8 | |
| APDU traffic via `host/bridge.py` | hundreds | including malformed ones while debugging |
| **application crashes on the device** | at least 2 | the contract-call encoder faulted; the device fell back to the dashboard |
| USB pipe wedged (`No dongle found`) | ~5 | each needing a physical unplug |
| physical unplug / replug | ~6 | several mid-session |

## Hypotheses

Ranked by plausibility, with what would reduce or test each. None is proven.

**H1 — every load is an unauthenticated host with a new key.**
Without a custom CA, `loadApp` generates a fresh root keypair per invocation
and the device reports a broken certificate chain. Ten loads is ten different
unknown hosts opening a secure channel to the secure element. Protection mode
exists to catch attacks on that channel.
*Test:* install a custom CA (`ledgerctl install-ca`, requires recovery mode)
so the host identity is stable and trusted, then resume normal development. If
resets stop, that is the answer. See finding 4 in the Ledger feedback: we
tried this once, were told the device was not in recovery mode, and concluded
a CA was unnecessary — true for one load, unexamined for fifty.

**H2 — the application crashed on the device.**
A BOLOS app faulting is, from the silicon's side, code jumping somewhere it
should not. That is also what fault injection looks like.
*Mitigation, already adopted:* reproduce crashes on Speculos first. The
encoder fault was found there in three iterations after a morning wasted on
hardware.

**H3 — abrupt disconnection mid-exchange.**
The macOS HID pipe wedged repeatedly, each time leaving an exchange
unfinished, each time resolved by yanking the cable.
*Mitigation:* close the transport cleanly; never unplug while a command is in
flight.

**H4 — the rate of delete/install cycles.**
Six delete/install pairs in a day is not a shape a normal user produces.

**H5 — power.** The device was on a hub that carried data. Discounted as the
*cause* — the counter kept climbing on a 90 W charger, and E6 describes
charging as the recovery path, not the trigger — but noted because it is
where we went wrong once.

## What we cannot do

A/B testing this is expensive: each trial costs a seed and several hours. So
the plan is not to reproduce it. It is to **make the next occurrence
legible**.

## Instrumentation

`host/journal.py` appends every device interaction to `.vela-journal.jsonl`
with a timestamp: loads, deletes, app launches, APDU classes, transport
errors, and crashes inferred from the app disappearing. `scripts/load.sh` and
`host/bridge.py` write to it.

The journal is local and gitignored. If protection mode appears again, the
preceding hours are on disk, and the sequence that triggered it can be read
rather than reconstructed from memory.

## Speculos is not the device

Worth stating plainly, because the mitigation for H2 leans on it. Speculos
runs the same ELF but not the same silicon: no NVRAM wear, no secure element,
no protection mode, no USB stack, and no stack protector behaving identically.
It found the encoder fault in minutes. It cannot find anything about
persistence, timing, or what the hardware considers an attack.

The division we are keeping to:

- **Speculos** — protocol shapes, refusal codes, encoder output, crashes,
  anything with a reproducible APDU
- **The Flex** — NVRAM surviving a restart, real signatures, and nothing else
  until it has already worked on the emulator

## Two wrong answers, kept

First `--appFlags 0x200`: the resets correlated with the loads because the
loads were most of what we were doing, a privileged flag looked like a
mechanism, and a load that did not wipe the device was read as confirmation
when the counter simply had not reached 100% yet.

Then battery depletion: the protection-mode screen mentions charging and the
device was on a hub. Wrong the same way — a plausible mechanism accepted
quickly, from a screen read faster than the article behind it.

The pattern in both is stopping at the first mechanism that fits. Hence this
note, and hence the journal.
