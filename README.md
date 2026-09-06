<p align="center">
  <img src="brand/vela-mark-256.png" width="96" alt="Vela">
</p>

<h1 align="center">Vela</h1>

<p align="center">
  <em>A spending mandate that lives inside a Ledger Secure Element.<br>
  The agent holds no key. The host holds no key. The chip decides.</em>
</p>

<p align="center">
  <a href="#the-experiment">The experiment</a> ·
  <a href="#what-the-chip-enforces">What the chip enforces</a> ·
  <a href="#verified-on-hedera-testnet">Verified on testnet</a> ·
  <a href="#run-it">Run it</a>
</p>

---

## The problem

An AI agent that pays for things needs a private key. Today that key sits on
the machine the agent runs on — in an env var, a keystore, a cloud secret.
Every safeguard around it is host software: a rate limiter the agent could be
talked into ignoring, an allowlist in a config file, a spend cap in the same
process that a prompt injection just took over.

That is not a spending limit. It is a suggestion, enforced by the thing being
attacked.

Custody hardware already solves the adjacent problem — it proves *you* approved
a transaction. But that model assumes a human at the screen for every payment,
which is exactly what an autonomous agent cannot do. Approve once per payment
and you do not have an agent. Approve once and hand over the key and you do not
have a limit.

## What Vela is

A BOLOS application for the Ledger Flex that holds a **mandate**: an envelope of
spending authority, granted once by a human on the device screen, and enforced
from then on by the Secure Element itself.

```
      Agent decides what to buy          →   has no key, no override
      Host builds the transaction        →   has no key, cannot read the mandate
      Chip checks it against the mandate  →   refuses, or signs
      Hedera settles it                  →   x402, real HBAR
      HCS records what the chip decided  →   signed by the chip, publicly checkable
```

You tap the device once, to say *this agent may spend up to 0.5 HBAR, never
more than 0.1 at a time, and only to these accounts*. After that the agent
runs unattended. Every payment is checked in silicon against terms the host
cannot read, cannot edit, and cannot skip — because the host never has the key
that would let it sign around them.

The mandate survives unplugging, app exit, and reboot. It is in NVRAM, not RAM,
and not on your disk.

## The experiment

Same rules. Same agent. Same attack. One variable: where the ceiling lives.

```console
$ ./scripts/experiment.sh
```

A policy of *100 HBAR total, 20 max per draw, may only pay 0.0.10365984* is
loaded twice — once into `host/software/policy.py`, an honest and correct
host-side implementation of exactly the same checks, and once into the chip.
Then the same agent tries to send 100 HBAR to an account that is not on the
list.

| | where the rules live | outcome |
|---|---|---|
| **software** | `host/software/policy.py`, same process as the agent | `[3/3] paying 100 HBAR to 0.0.66666666 … SETTLED` |
| **device** | Ledger Flex Secure Element | `[3/3] … REFUSED (payee_not_allowed)` |

The software policy is not a straw man. It is not buggy, and it is not weaker
than the chip's. It loses because it is reachable: the attacker in this
scenario has already reached the agent's process, and a rule that lives in the
process being attacked is a rule the attacker owns. The chip's copy is behind
a hardware boundary the host cannot cross.

That is the whole thesis, and it is one command.

## What the chip enforces

```c
typedef struct {
    uint8_t  in_use;
    uint8_t  n_payees;
    uint8_t  agent_id[AGENT_ID_LEN];      // 20
    uint64_t payees[MANDATE_MAX_PAYEES];  // Hedera account numbers, not hashes
    uint64_t budget_total, reserved, spent, per_call_max;
    uint32_t expiry, seq;
} mandate_t;                              // 96 bytes; 3 slots fit in NVRAM
```

Every `AUTHORIZE` runs five checks in the Secure Element, in order, before a
signature exists:

1. **expiry** — has the envelope run out of time
2. **payee** — is the credited account on the allowlist, matched as a full
   Hedera account number, not a truncated hash
3. **per-draw ceiling** — is this single payment under `per_call_max`
4. **budget** — is it under `budget_total − reserved − spent`
5. **reserve, then sign** — `reserved` is committed to NVRAM *before* the
   signature is produced, so a host that takes a signature and never reports
   back has still spent the budget

Refuse and the host gets a status word and nothing else. There is no signature
to salvage, because none was ever computed.

The chip also builds the Hedera transaction body itself — `app/src/hedera/tx.c`
is a protobuf serialiser running on-chip. It does not sign bytes the host hands
it. It signs bytes it constructed from fields it checked, which is what makes
the checks mean anything: a host that lies about the payee in its own
serialisation is signing a payee the chip already rejected.

Signing is domain-separated. `hedera_sign_anchor()` prefixes `vela.anchor.v1`
before signing, so an audit-log statement can never be replayed as a transfer.

## Verified on Hedera testnet

Not mocked. Not on an emulator. Real HBAR, real consensus, from a physical
Ledger Flex.

| what | evidence |
|---|---|
| Payment signed in the Secure Element | account [`0.0.10392125`](https://hashscan.io/testnet/account/0.0.10392125) — its private key exists on no disk here |
| x402 settlement | Blocky402 facilitator, `CRYPTOTRANSFER`, `result: SUCCESS` |
| Public audit log | topic [`0.0.10393818`](https://hashscan.io/testnet/topic/0.0.10393818) |
| On-chip refusals | `payee_not_allowed`, `over_per_call`, `over_budget` |
| NVRAM persistence | *IDENTICAL — the envelope survived a full application restart* |

The buyer account is controlled by the key derived on the device at
`m/44'/3030'/0'/0'/0'`. Nothing on this machine can spend from it. The only
path to a signature runs through a mandate check in the chip.

### Anyone can check it

`hedera/verify.mjs` reads the Hedera mirror node and **nothing else** — no
local state, no trust in this repo, no trust in the host that produced the log.

```console
$ node hedera/verify.mjs 0.0.10393818

topic   0.0.10393818
source  https://testnet.mirrornode.hedera.com/api/v1 — and nothing else

mandate 0f39b1086dbf4421…  granted 1788707364  8 draw(s)
  ok    seq 1 follows 0 with no gap
  ok    remaining 49000000 is not negative
  ok    seq 2 follows 1 with no gap
  ok    remaining 48000000 = 49000000 - 1000000
  ok    remaining 48000000 is not negative
  ok    seq 3 follows 2 with no gap
  ok    remaining 40000000 = 48000000 - 8000000
  ok    remaining 40000000 is not negative
  ok    seq 4 follows 3 with no gap
  ok    draw 4 released within the envelope (30000000 <= 40000000)
  ok    remaining 30000000 is not negative
  ok    seq 5 follows 4 with no gap
  ok    draw 5 released within the envelope (20000000 <= 40000000)
  ok    remaining 20000000 is not negative
  ok    seq 6 follows 5 with no gap
  ok    draw 6 released within the envelope (10000000 <= 40000000)
  …
  → complete and consistent
```

Each anchored record carries a 29-byte statement the chip signed —
`mandate_id ‖ seq ‖ payee ‖ amount ‖ remaining` — plus its Ed25519 signature.
Without those the log would be the host's account of what the chip decided.
With them it is the chip's own, and the host is only the courier.

What the verifier proves: every anchored draw settled on Hedera exactly as
recorded, in order, against one fixed envelope, and never past its ceiling.

What it does not prove: that the service delivered anything, that the envelope
was a sensible size, or that the agent did anything useful. It is stated that
way in the output too. A verifier that overclaims is worse than none.

## The pieces

```
app/         BOLOS application for Ledger Flex — the mandate, the on-chip
             Hedera serialiser, the NBGL control panel  (~4.4k lines of C)
hedera/      x402-gated seller, the Ledger-backed x402 signer, HCS anchoring,
             the public verifier, the end-to-end demo, the agent gateway, and
             the private risk feed the enclave screens against
cre/         Chainlink CRE workflow — the confidential spend advisor, running
             in an AWS Nitro enclave
web/         a page where you can press the button yourself and watch the
             chip refuse
host/        APDU bridge, device probes, the software control arm, Key Ring
             enrolment
scripts/     build, load, Speculos, the persistence test, the experiment
brand/       the mark, and the four device glyphs generated from it
docs/        developer-experience feedback for Ledger, the agent
             integration guide, and the Lean Canvas
```

### On-device control panel

The app is not a dialog that appears when the host asks. Opening Vela lands
directly on the list of live mandates — what each agent may spend, what is
left, who it may pay — with per-mandate detail and revocation, plus a
*Revoke all mandates* button. Authority you cannot see is not authority you
control, so it is the home screen rather than a settings sub-page.

### Key Ring enrolment

`host/ring/enroll.cjs` runs the Ledger Key Ring Protocol ceremony: an agent
*requests* membership, and a human *grants* it on the device. Removal requires
the device and rotates the key, so revocation is not a database update someone
can undo.

## Run it

Requires a Ledger Flex in developer mode, Docker, Node 20+, and Python 3.9+.

```bash
./scripts/build.sh                     # build the BOLOS app in ledger-app-builder
./scripts/load.sh                      # sideload it (quit Ledger Wallet first)

python3 host/bridge.py &               # APDU shim on :8099
node hedera/seller.mjs &               # x402-gated service on :4021

node hedera/demo.mjs                   # grant once on the device, then N
                                       # autonomous paid draws, each anchored
node hedera/verify.mjs $HEDERA_TOPIC_ID   # check the log from the mirror node
```

An agent does not run scripts, so `hedera/gateway.mjs` exposes the same thing
as three tools it can call — `GET /envelope`, `POST /pay`, `GET /receipts`.
The rule that surface is built around: **a refusal comes back as a 200 with a
reason and `"terminal": true`, never a 500.** An agent that receives a 500
retries, and retrying a hardware refusal is the worst thing it can do here —
the chip is deterministic, so the second attempt fails identically and a turn
is gone. See [`docs/AGENT-GUIDE.md`](docs/AGENT-GUIDE.md).

`./scripts/experiment.sh` runs the controlled experiment.
`./scripts/persistence-test.sh` tears the app down and proves the envelope
survived.
`node web/server.mjs` serves the interface on :4050. Everything this project
argues happens either inside a Secure Element or in a terminal, and neither is
watchable — so the page exists to let someone press *buy the 0.15 tier* against
a 0.10 ceiling and watch the hardware say no.

`node hedera/refusals.mjs` exercises all four refusals without damaging the
audit log: the reservations it needs to reach `over_budget` are released and
the releases are published, so the envelope ends where it started.
`./scripts/advisor.sh` runs the confidential workflow and keeps its verdict.
`./scripts/composition.sh` shows the enclave narrowing the mandate, and
failing to widen it.

Two things that will cost you an hour if nobody tells you: **quit Ledger
Wallet** before touching the device (it holds the HID handle), and note that
`scripts/build.sh` mounts the *repository root*, not `app/` — the Ledger SDK
calls `git rev-parse --show-toplevel` and silently drops every source file if
it does not find a git repository.

## The second boundary

The mandate in the chip is hard, and it is static. The Secure Element has no
network and no clock beyond an expiry, so it cannot learn that an account which
was reputable when the human granted the envelope is a drainer today. That is a
real gap — and closing it on the host would close it in the one place this
whole project argues you cannot trust.

So it is closed in an enclave instead. [`cre/spend-advisor`](cre/spend-advisor)
is a Chainlink CRE workflow declared with `handlerInTee` against AWS Nitro in
`us-west-2`. It screens the mandate's payees against a private risk feed and
returns a verdict.

Two sensitive things meet in that handler, and the second is the one that is
easy to miss:

- **The feed's API key.** It belongs to the operator, not to whichever node
  happens to pick up the trigger.
- **The questions.** Even against a feed with public answers, asking about four
  specific accounts tells a listener exactly which accounts an autonomous agent
  is authorised to pay — the shortlist an attacker wants in order to know where
  to aim. Confidential HTTP keeps the query pattern inside the enclave, not
  just the key.

**The composition is one-directional, and that is the whole point:**

> The enclave can narrow what the chip allows. It can never widen it.

`./scripts/composition.sh` tests both halves, because proving only the first
would be marketing:

```console
A. The enclave turns against a payee the chip still allows.
     enclave: deny 0.0.10388937: adverse media, under review (score 88)
     the agent asks for the cheap tier, exactly as before:
       advisor_denied
     nothing changed on the device. Only what the enclave knows.

B. The same request, once the enclave clears the payee.
       paid, tx 0.0.7162784@1788702885.000000000

C. The enclave blesses an account the chip has never heard of.
     enclave: allow 0.0.77777777  no adverse signal (score 3)
     chip:    0xb104  payee_not_allowed
```

C is the one that matters. A compromised advisor costs availability. It never
costs authority — the mandate lives in NVRAM behind a hardware boundary, and
nothing the enclave emits is an input to it.

The gateway reports advisor refusals as `terminal: false`, unlike the chip's.
The chip is deterministic and will refuse identically forever; the advisor
holds a live opinion the next run may reverse. Marking it terminal would have
an agent abandon a counterparty for good over a signal that was true for one
afternoon.

## Notes for Ledger

Building this surfaced fourteen concrete developer-experience problems,
written up with reproductions in
[`docs/FEEDBACK-LEDGER.md`](docs/FEEDBACK-LEDGER.md).

**The one that cost the most is still unexplained, and that is the finding.**
The Flex factory-reset itself three times over two days, taking the seed with
it. It was protection mode: the device interprets some event as an attack and
resets. It knows which event. It never says, and neither does the loader
talking to it — the device comes back showing *"Welcome to Ledger Flex"* and
passes its genuine check, because it is genuine and empty. A development loop
of repeated sideloads over an untrusted channel, crashing apps and wedged USB
pipes resembles the thing that protection exists to catch. We diagnosed it
wrong twice before reading the device's own screen, and the write-up records
both wrong answers because the reasoning is the lesson.

Most of the rest are one error string away from being fine. Three more are
real bugs:

- **`bip32_derive_with_seed_get_pubkey_256` writes 65 bytes for Ed25519.**
  The documented output is a 32-byte key; the SDK writes an uncompressed point.
  A caller sizing the buffer from the documentation gets a 33-byte stack
  overrun and a wrong public key beginning `04`. Downstream this produced a
  Hedera account nobody could ever spend from, failing as `INVALID_SIGNATURE`
  a long way from the cause.
- **`buffer_move()` copies the entire remaining buffer**, not the requested
  length, so any multi-field APDU fails on its first field.
- **`DISABLE_DEFAULT_IO_SEPROXY_BUFFER_SIZE` is documented in the boilerplate
  Makefile and read by nothing.** Setting it changes no buffer size, the build
  succeeds in silence, and the app dies at runtime with no status word when a
  response exceeds the size it thought it had raised.

A twelfth finding was drafted and then dropped: a crash we first blamed on our
own 64px glyph turned out to be the buffer overrun above. The correlation was
real and the conclusion was wrong, so the write-up records that rather than
shipping a false report.

## Built on

[Ledger](https://developers.ledger.com) BOLOS/NBGL and the Ledger Key Ring
Protocol · [Hedera](https://hedera.com) for settlement and consensus ·
[x402](https://x402.org) with the Blocky402 facilitator ·
[Chainlink CRE](https://docs.chain.link/cre) Confidential Workflows for the
enclave half.

`app/` derives from [`LedgerHQ/app-boilerplate`](https://github.com/LedgerHQ/app-boilerplate), Apache-2.0.
