/**
 * Vela as a service an agent can use.
 *
 * The rest of this repo is a demo: one script grants, draws, anchors, and
 * narrates. An agent does not run scripts. It calls tools, reads what came
 * back, and decides what to do next — so the mandate has to be legible to it,
 * and a refusal has to arrive as a fact it can act on rather than a stack
 * trace.
 *
 * Three tools:
 *
 *   GET  /envelope   what may I spend, and on what
 *   POST /pay        buy this URL, if the chip agrees
 *   GET  /receipts   what the chip says it authorised, from the mirror node
 *
 * The design rule throughout: a refusal is a 200 with a reason, not a 500.
 * An agent that receives a 500 retries. Retrying a refusal is the one thing
 * it must never do — the chip will refuse identically every time, and the
 * agent burns its context discovering a ceiling that was published at
 * /envelope all along.
 */
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

import { createLedgerHederaSigner } from "./ledger-signer.mjs";
import { drawRecord, makeAnchor, mandateDigest, releaseRecord } from "./anchor.mjs";
import { currentInstance } from "./instance.mjs";
import { readFileSync, existsSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(ROOT, ".env") });

const NETWORK = "hedera:testnet";
const PORT = Number(process.env.GATEWAY_PORT ?? 4030);
const SLOT = 0;
const STATE_LEN = 69;

/** The chip's status words, as things an agent can reason about. */
const REFUSALS = {
  0xb103: { reason: "expired", terminal: true,
            advice: "the envelope has run out of time; a human must grant a new one" },
  0xb104: { reason: "payee_not_allowed", terminal: true,
            advice: "this account is not on the mandate; no amount will make it pass" },
  0xb105: { reason: "over_per_call", terminal: true,
            advice: "this single payment exceeds per_call_max; a cheaper tier may fit" },
  0xb106: { reason: "over_budget", terminal: true,
            advice: "the envelope has less left than this costs; check /envelope for available" },
};

let signer;
let lastDraw = null;

/**
 * The confidential advisor's latest verdict.
 *
 * Produced by a Chainlink CRE workflow running in an AWS Nitro enclave
 * (cre/spend-advisor). It exists because the chip's mandate is hard but
 * static: the Secure Element has no network and no clock beyond an expiry, so
 * it cannot learn that an account which was reputable when the human granted
 * the envelope is a drainer today.
 *
 * The composition is one-directional and that is the whole point. This can
 * only remove payees from consideration. It cannot add one, raise a ceiling,
 * or extend an envelope — those live in NVRAM behind a hardware boundary, and
 * nothing here is an input to them. A compromised advisor costs availability,
 * never authority.
 */
function advice() {
  const file = join(ROOT, "cre", "advice.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const json = (res, code, body) => {
  const s = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(s);
};

const readBody = (req) =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve(null); } });
  });

/**
 * The allowlist, appended after the fixed fields by the chip.
 *
 * Older firmware stopped at seq, so the tail may be absent. Returning null
 * rather than [] keeps "the chip did not tell me" distinct from "the chip
 * told me nobody" — an agent should treat those differently, and so should
 * the digest reconstruction below.
 */
function payeesFrom(state) {
  if (state.length < 70) return null;
  const n = state.readUInt8(69);
  if (state.length < 70 + n * 8) return null;
  return Array.from({ length: n }, (_, i) =>
    `0.0.${state.readBigUInt64BE(70 + i * 8)}`);
}

/** The mandate, read from the chip on every call — it can be revoked mid-run. */
async function envelope() {
  const state = await signer.transport
    .exchange(Buffer.from([0xe0, 0x10, 0, 0, 0]))
    .catch((e) => (e.sw === 0xb102 ? null : Promise.reject(e)));

  if (!state || state.length < STATE_LEN) return null;

  return {
    agent: state.subarray(1, 21).toString("hex"),
    budget_total: state.readBigUInt64BE(21),
    reserved: state.readBigUInt64BE(29),
    spent: state.readBigUInt64BE(37),
    per_call_max: state.readBigUInt64BE(45),
    available: state.readBigUInt64BE(53),
    expiry: state.readUInt32BE(61),
    draws_so_far: state.readUInt32BE(65),
    payees: payeesFrom(state),
    asset: "HBAR, in tinybars",
  };
}

/**
 * The fields every anchored record shares, all of them read back from the
 * chip rather than from local configuration — a digest built from config
 * would name an envelope the chip may never have held.
 */
function recordFields(envelopeBefore, accepts, price) {
  return {
    mandateHash: mandateDigest({
      agentId: Buffer.from(envelopeBefore.agent, "hex"),
      payees: envelopeBefore.payees.map((p) => BigInt(p.split(".")[2])),
      budgetTotal: envelopeBefore.budget_total,
      perCallMax: envelopeBefore.per_call_max,
      expiry: envelopeBefore.expiry,
    }),
    instance: currentInstance().id,
    seq: lastDraw.seq,
    payee: BigInt(accepts.payTo.split(".")[2]),
    amount: price,
    remaining: lastDraw.available,
    anchor: lastDraw.anchor,
    anchorSig: lastDraw.anchorSig,
  };
}

async function submit(record) {
  const anchor = makeAnchor({
    topicId: process.env.HEDERA_TOPIC_ID,
    operatorId: process.env.HEDERA_TREASURY_ID,
    operatorKey: process.env.HEDERA_TREASURY_KEY,
  });
  try {
    return await anchor.submit(record);
  } finally {
    anchor.close();
  }
}

const publishable = (e) => process.env.HEDERA_TOPIC_ID && lastDraw && e?.payees;

async function publishDraw(before, accepts, price, tx) {
  if (!publishable(before)) return null;
  return submit(drawRecord({ ...recordFields(before, accepts, price), tx }));
}

async function publishRelease(before, accepts, price) {
  if (!publishable(before)) return null;
  return submit(releaseRecord(recordFields(before, accepts, price)));
}

const routes = {
  "GET /envelope": async (_req, res) => {
    const e = await envelope();
    if (!e) {
      return json(res, 200, {
        mandate: null,
        note: "no mandate in the chip. Nothing can be paid until a human grants " +
              "one on the device. This is not an error you can retry past.",
      });
    }
    const a = advice();
    json(res, 200, {
      mandate: e,
      // Kept as a separate object rather than folded into the mandate. They
      // are not the same kind of fact: one is enforced in silicon and cannot
      // be talked around, the other is a current opinion that may change by
      // the next run. Merging them would let a reader mistake advice for
      // authority.
      advisory: a
        ? { denied: a.deny.map((d) => ({ payee: d.payee, reason: d.reason })),
            at: a.at,
            source: "chainlink cre confidential workflow, aws nitro" }
        : null,
      note: "the mandate comes from the Secure Element, not from this host. " +
            "Plan against available and per_call_max before choosing what to buy. " +
            "advisory narrows the mandate; it never widens it.",
    });
  },

  "POST /pay": async (req, res) => {
    const body = await readBody(req);
    if (!body?.url) return json(res, 400, { error: "give me {\"url\": \"…\"}" });

    const before = await envelope();
    if (!before) {
      return json(res, 200, {
        paid: false, refused: true, reason: "no_mandate", terminal: true,
        advice: "a human must grant an envelope on the device first",
      });
    }

    // No client-side spend cap here, and that is deliberate.
    //
    // Mirroring per_call_max into x402's own spendControls looks like defence
    // in depth and is the opposite. The client refuses first, the chip is
    // never asked, and what comes back is the SDK's message about its own
    // configuration — so the refusal an operator sees is a host-side one,
    // produced by exactly the kind of control this project exists to argue
    // against. Worse, it is silent about the disagreement: raise the host cap
    // above the mandate and nothing warns you which one is actually holding.
    //
    // The ceiling that matters is in the Secure Element. Let the request
    // reach it and let it answer.
    const client = new x402Client().register(NETWORK, new ExactHederaScheme(signer));
    // allowedAssets: true, not a cap. x402 applies spend controls by default
    // and HBAR is not one of its default assets, so leaving this unset does
    // not mean "no host-side limit" — it means every payment is rejected by
    // the client before the chip sees it.
    client.setSpendControls({ allowedAssets: true });
    const http = new x402HTTPClient(client);

    const first = await fetch(body.url).catch(() => null);
    if (!first) return json(res, 502, { error: `could not reach ${body.url}` });

    const required = http.getPaymentRequiredResponse(
      (n) => first.headers.get(n),
      await first.clone().json().catch(() => undefined),
    );
    if (!required) {
      return json(res, 200, { paid: false, free: true,
                              body: await first.json().catch(() => null),
                              note: "the service did not ask to be paid" });
    }

    const accepts = required.accepts[0];
    const price = BigInt(accepts.amount);

    // Consulted here because this is the first point where the payee is
    // known, and still before anything is signed. Checked before the chip,
    // not instead of it: declining now saves a pointless round trip to a
    // device that would have said yes, and if this check were skipped or
    // subverted the payment would still have to survive the mandate. That
    // asymmetry is what makes it safe to run this part on the host at all.
    const a = advice();
    const flagged = a?.deny.find((d) => d.payee === accepts.payTo);
    if (flagged) {
      return json(res, 200, {
        paid: false, refused: true, reason: "advisor_denied",
        // Not terminal. Unlike the chip's refusals this is a live opinion
        // about the world, and the next enclave run may clear it. Calling it
        // terminal would have an agent abandon a counterparty for good over
        // a signal that was true for an afternoon.
        terminal: false,
        advice: `the confidential advisor flagged this payee: ${flagged.reason}`,
        score: flagged.score,
        payee: accepts.payTo,
        note: "this narrows the mandate. The chip would have allowed it; an " +
              "enclave in aws nitro said it is a bad idea right now.",
      });
    }

    // Ask the chip. A refusal here is the point of the whole project, so it
    // is reported as an outcome with a reason, not raised as a failure.
    let payload;
    try {
      payload = await http.createPaymentPayload(required);
    } catch (e) {
      const r = REFUSALS[e?.sw ?? e?.cause?.sw];
      if (r) {
        return json(res, 200, {
          paid: false, refused: true, ...r,
          asked_for: String(price), envelope: before,
        });
      }
      return json(res, 500, { error: String(e?.message ?? e) });
    }

    const paid = await fetch(body.url, { headers: http.encodePaymentSignatureHeader(payload) });
    const result = await http.processResponse(paid);
    if (result.paymentStatus !== "settled") {
      // The chip already authorised this, which burned a sequence number and
      // reserved the amount. Give both back, and say so publicly: an
      // unexplained gap in the log is indistinguishable from a payment
      // somebody chose not to publish, and silence here would put one there.
      await signer.settle(0n).catch(() => {});
      const released = await publishRelease(before, accepts, price)
        .catch(() => null);
      return json(res, 200, { paid: false, refused: false, reason: "not_settled",
                              terminal: false, detail: result,
                              released_as_message: released });
    }

    // Release the difference between what was reserved and what was actually
    // spent. Skipping this leaks budget: the chip reserved before signing.
    await signer.settle(price);
    const after = await envelope();
    const tx = result.header.transaction;

    const anchored = await publishDraw(before, accepts, price, tx).catch(() => null);

    json(res, 200, {
      paid: true,
      spent: String(price),
      tx,
      response: result.body ?? (await paid.json().catch(() => null)),
      remaining: after ? String(after.available) : null,
      anchored_as_message: anchored,
      note: "signed inside the Secure Element after the chip checked this " +
            "payee and this amount against the mandate",
    });
  },

  "GET /receipts": async (_req, res) => {
    const topic = process.env.HEDERA_TOPIC_ID;
    if (!topic) return json(res, 200, { receipts: [], note: "no topic configured" });
    const url = `${process.env.HEDERA_MIRROR}/topics/${topic}/messages?limit=25&order=desc`;
    const r = await fetch(url).then((x) => x.json()).catch(() => null);
    if (!r) return json(res, 502, { error: "mirror node unreachable" });
    json(res, 200, {
      topic,
      receipts: (r.messages ?? []).map((m) => {
        try { return JSON.parse(Buffer.from(m.message, "base64").toString("utf8")); }
        catch { return null; }
      }).filter(Boolean),
      note: "public, and checkable without this host: node verify.mjs " + topic,
    });
  },
};

const server = createServer(async (req, res) => {
  const key = `${req.method} ${req.url.split("?")[0]}`;
  const handler = routes[key];
  if (!handler) {
    return json(res, 404, { error: "no such tool", tools: Object.keys(routes) });
  }
  try {
    await handler(req, res);
  } catch (e) {
    json(res, 500, { error: String(e?.message ?? e) });
  }
});

signer = await createLedgerHederaSigner({
  accountId: process.env.HEDERA_BUYER_ID,
  slot: SLOT,
  onDraw: (d) => { lastDraw = d; },
});

server.listen(PORT, () => {
  console.log(`vela gateway on :${PORT}`);
  console.log(`  GET  /envelope   what the chip will allow`);
  console.log(`  POST /pay        {"url": "..."} — buy it, if the chip agrees`);
  console.log(`  GET  /receipts   the public log`);
  console.log(`\nbuyer ${process.env.HEDERA_BUYER_ID}, key in the Secure Element`);
});
