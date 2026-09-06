# Paying for things under a hardware mandate

A guide for an agent — or for whoever is writing its system prompt — using the
Vela Gateway (`hedera/gateway.mjs`).

**When to reach for it:** you need to buy something and you do not hold a key.

---

## What this service is

Vela is a spending envelope that lives inside a Ledger Secure Element. A human
granted it once, on the device, and it says three things: a total budget, a
ceiling per individual payment, and a list of accounts that may be paid.

You do not hold the key. Neither does the host you are running on. Every
payment is checked by the chip against that envelope before a signature
exists.

This changes how you should behave, in one specific way: **your budget is not
advisory.** You cannot exceed it by trying harder, by retrying, or by
rephrasing. The chip is not a policy you can talk around.

## Call `/envelope` before you plan, not after you fail

```
GET /envelope
→ { "mandate": { "available": "38000000",
                 "per_call_max": "5000000",
                 "budget_total": "50000000",
                 "payees": ["0.0.10388937"],
                 "draws_so_far": 6 } }
```

Amounts are **tinybars**: 100,000,000 tinybars = 1 HBAR. So the envelope above
has 0.38 HBAR left and will not sign any single payment above 0.05 HBAR.

`payees` is the whole list of accounts this envelope may pay. It comes from the
chip, not from the host's configuration, so it is the same list the refusals
are decided against.

Read this first. It is one call, and it tells you which options are actually
open to you. A service offering a 0.01 tier and a 0.08 tier is offering you one
tier, not two, if `per_call_max` is 0.05 — and you can know that before you
spend a turn finding out.

## Refusals are answers, not errors

```
POST /pay  {"url": "https://…/infer/exhaustive"}
→ { "paid": false, "refused": true,
    "reason": "over_per_call", "terminal": true,
    "advice": "this single payment exceeds per_call_max; a cheaper tier may fit",
    "asked_for": "15000000",
    "envelope": { "per_call_max": "10000000", "available": "39000000", … } }
```

The envelope comes back with the refusal, so the next move needs no extra
call: 0.15 HBAR did not fit under a 0.10 ceiling, 0.08 does, and the tier below
is right there in the service's own listing.

This returns HTTP 200. It is not a failure of the service; it is the service
working. `"terminal": true` means exactly what it says:

> **Never retry a terminal refusal.** The chip is deterministic. The same
> request will be refused identically, forever. Retrying costs you turns and
> changes nothing.

The four terminal refusals, and the only sensible response to each:

| `reason` | what it means | what to do |
|---|---|---|
| `over_per_call` | one payment above the ceiling | pick a cheaper tier, or split the work if the service allows it |
| `over_budget` | not enough left in the envelope | stop buying; report what you could not afford |
| `payee_not_allowed` | that account is not on the mandate | do not look for another route to it — there isn't one |
| `expired` | the envelope ran out of time | stop; a human must grant a new one |
| `no_mandate` | nothing granted | stop; a human must grant one on the device |

One refusal is **not** terminal, and the difference matters:

| `reason` | | |
|---|---|---|
| `advisor_denied` | a confidential workflow running in an enclave flagged this payee | try again later, or pick another counterparty — this is a live opinion about the world, not a fixed rule, and the next run may reverse it |

The chip is deterministic: retrying its refusal is pure waste. The advisor is
not. Treating them the same way in either direction is a mistake — retry the
chip and you loop, abandon the advisor's verdict permanently and you drop a
counterparty over a signal that was true for one afternoon.

`over_budget` and `payee_not_allowed` in particular are worth reading as
information about the world rather than obstacles. If a payee is not on the
list, the human who granted this envelope decided you should not pay it. That
decision is the product, not a bug in your plan.

## Buying something

```
POST /pay  {"url": "https://…/infer/triage"}
→ { "paid": true, "spent": "1000000",
    "tx": "0.0.7162784@1788699233.000000000",
    "response": { "verdict": "nothing unusual" },
    "remaining": "37000000",
    "anchored_as_message": 12 }
```

One call does the whole x402 exchange: it discovers the price, asks the chip
to sign, settles on Hedera, releases the unused reserve, and publishes a
signed record of what happened. You do not need to handle 402s, build
payloads, or manage a nonce.

`response` is the thing you actually wanted. `remaining` is what is left —
carry it forward instead of calling `/envelope` again.

## Budget discipline that actually helps

- **Price the whole plan before the first purchase.** If you need three
  lookups and the envelope holds two, decide now which two matter, rather than
  discovering it on the third.
- **Prefer the cheap tier unless you can say why the expensive one is worth
  8×.** "Deeper is better" is not a reason. A specific ambiguity in the cheap
  answer that the expensive one would resolve is a reason.
- **Leave headroom.** Spending an envelope to zero on speculative calls means
  the one thing you genuinely needed to buy is the thing you cannot.

## Showing your work

```
GET /receipts
```

Every draw is anchored on a public Hedera topic with a statement the chip
itself signed. Refusals are not in it — the chip signs nothing when it refuses,
so there is nothing for it to attest. The log is what was authorised, not what
was attempted. If you are asked to justify what you spent, this is the answer,
and it does not depend on your account of events being believed — anyone can
check it against the mirror node with `node verify.mjs <topic>`.

## What this service is not

It is not a wallet you can top up, and it is not a way to move funds. It buys
things from services that quote a price, and only those, and only up to the
ceiling a human set. If your task requires exceeding the envelope, the correct
outcome is to say so and stop.
