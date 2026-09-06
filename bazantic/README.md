# Bazantic

Three prizes, $3,000 total. Vela fits two of them cleanly.

| prize | amount | status |
|---|---|---|
| Help an Agent Use Your Hackathon Project | $1,000 | ⚠️ **Continuity track only** — Vela is a new project, so this is likely out |
| Best Recipe Using EthGlobal Hackathon Sponsor APIs | $1,000 | ✅ the Recipe depends on Ledger *and* Hedera, not one plus decoration |
| Agentify a New API | $1,000 | ✅ nothing in Bazantic today sells hardware-enforced spending authority |

## Blocked on one thing

All three require a `bazantic.com` account, and signup is waitlist-gated —
the site offers "Join the Waitlist for Bazantic for Developers". That account
has to be created by a human, and the Bazantic username is a required
submission field.

Everything that does not depend on the account is done and in this repo.

## What is ready

**The service.** `hedera/gateway.mjs` exposes Vela as three tools an agent can
actually call:

```
GET  /envelope   what the chip will allow — budget, per-payment ceiling, allowlist
POST /pay        {"url": "…"} — discover the price, ask the chip, settle, anchor
GET  /receipts   the public log, checkable without trusting this host
```

The design rule that matters for agents: **a refusal is a 200 with a reason and
`"terminal": true`, never a 500.** An agent that gets a 500 retries. Retrying a
hardware refusal is the one thing it must never do — the chip is deterministic,
so the second attempt fails identically and the agent has spent a turn learning
nothing that `/envelope` would have told it for free.

**The Recipe.** [`RECIPE.md`](RECIPE.md) — when to reach for the service, why
budget is not advisory, the four terminal refusals and the only sensible
response to each, and how to price a plan before spending the first tinybar.

**The measurement.** [`ab-test.mjs`](ab-test.mjs) runs the same task twice with
the same model, prompt, settings and tools, changing only whether the Recipe is
in the system prompt.

## The hypothesis being tested

Narrow enough to be wrong: an agent that has not been told the envelope exists
picks the expensive tier, gets refused by the chip, and **retries** — because
retrying is what almost every other 4xx-shaped outcome rewards. An agent that
has read the Recipe calls `/envelope` first, sees `per_call_max`, and picks the
tier that fits.

Set the envelope so the two tiers straddle the ceiling, and the difference is
forced into the open rather than argued for:

```bash
# per_call_max 0.05 HBAR; triage costs 0.01, synthesis 0.08
node hedera/gateway.mjs &
node hedera/seller.mjs &
ANTHROPIC_API_KEY=… node bazantic/ab-test.mjs
```

Measured: tool calls, tinybars spent, whether the task finished, and how many
times a terminal refusal was retried. The last one is the honest signal — it is
the specific mistake the Recipe exists to prevent, so it is the number that can
embarrass the claim if the Recipe does not work.

## When the account exists

1. Create the Gateway in Bazantic pointing at the deployed `gateway.mjs`,
   with x402/MPP on Hedera testnet.
2. Paste `RECIPE.md` as the Recipe.
3. Run `ab-test.mjs` against the hosted Gateway and record the two runs.
4. Screen recording: the envelope on the device screen, run A retrying into a
   wall, run B reading the ceiling and buying the right thing, then
   `verify.mjs` checking both against the mirror node.
5. Submit with the Bazantic username.

For *Agentify a New API*, the novelty claim is specific: Bazantic today has
services that take payment. It has none that **refuse** it in hardware, on
terms a human set once and no agent, host, or prompt injection can move.
