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

/**
 * Which slot a caller spends from.
 *
 * The gateway was single-tenant: every request drew on slot 0. With three
 * agents on one device that is not a simplification, it is wrong — an agent
 * would spend another agent's envelope and the audit log would attribute it
 * to the wrong one.
 *
 * The slot comes from the caller's identity, never from the request. An agent
 * that could name its own slot could name someone else's, and "whose budget"
 * is not a thing the spender gets to decide.
 *
 * The roster is shared with the broker rather than duplicated. Two files that
 * must agree about who exists is one file that will eventually disagree with
 * itself, and the failure would be silent: an agent authenticated by one and
 * mapped to the wrong slot by the other.
 */
const ROSTER = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, "broker", "fleet.json"), "utf8")).agents ?? {};
  } catch {
    return {};
  }
})();

function callerSlot(req, url) {
  const token = String(req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "").trim();

  if (token) {
    const found = Object.values(ROSTER).find((a) => a.token === token);
    if (!found) return null;
    // An identified agent gets its own slot and cannot ask for another. The
    // query string is ignored rather than merged: a request that both proves
    // who it is and asks to be someone else is not ambiguous, it is a
    // request to be refused.
    return { slot: found.slot, agent: found.label, anonymous: false };
  }

  // The operator path. The local console has no agent identity — it is the
  // human's view of the whole fleet — so it names the slot it wants to look
  // at. That is only acceptable because it is the same person who granted
  // the envelopes in the first place.
  const asked = Number(url?.searchParams?.get("slot") ?? SLOT);
  if (!Number.isInteger(asked) || asked < 0 || asked > 2) return null;
  return { slot: asked, agent: null, anonymous: true };
}

/**
 * What may be bought, and where it lives.
 *
 * The broker refuses to take a URL from an agent, because a service that
 * attaches a credential to an address someone else chose is a confused
 * deputy. The same argument applies here with the same force: an agent that
 * names the endpoint is an agent choosing who gets paid, and "who gets paid"
 * is the one field the mandate exists to control.
 *
 * It also happens to be the only shape that works. The agent runs in a
 * container and sees the seller at host.docker.internal; this gateway runs on
 * the host and does not. An agent's view of the network is not a fact about
 * the network.
 *
 * So services are named here and invoked by name. A raw URL is still accepted
 * from an operator on the loopback path, which is what the local console uses.
 */
const SELLER = `http://127.0.0.1:${process.env.SELLER_PORT ?? 4021}`;
const SERVICES = {
  triage: `${SELLER}/infer/triage`,
  synthesis: `${SELLER}/infer/synthesis`,
  exhaustive: `${SELLER}/infer/exhaustive`,
};
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
  0xb109: { reason: "contract_not_allowed", terminal: true,
            advice: "this contract is not on the mandate; no calldata will make it pass" },
  0xb10a: { reason: "selector_not_allowed", terminal: true,
            advice: "that function is not permitted on this contract — the same router " +
                    "that swaps also approves, and only one of them was granted" },
  0xb10b: { reason: "recipient_not_self", terminal: true,
            advice: "the call would hand value to an address that is not this device. " +
                    "The chip will encode the contract, the function and the amount you " +
                    "asked for, and refuse the one field that lets the proceeds leave" },
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

/**
 * The contract terms, appended after the payees.
 *
 * A transfer's payee is in the transaction body, so an allowlist of accounts
 * is enough to describe what a mandate permits. A contract call's recipient
 * is in ABI-encoded arguments the body does not interpret — so the mandate
 * also names which contracts may be called, which functions on them, and
 * which argument carries the address value flows to. That last one is what
 * the chip binds to its own account.
 *
 * Null when the chip is older than this layout: "did not say" and "said
 * nothing is allowed" have to stay distinguishable.
 */
/**
 * The name the human gave this agent when they granted its envelope.
 *
 * Read from the chip rather than from the broker's roster, and the difference
 * matters: the roster is a file on a host, and a host that renamed an agent
 * could show one name on a console while the device shows another. The screen
 * a human taps to revoke is the one that has to be right.
 */
function labelFrom(state) {
  if (state.length < 70) return null;
  let off = 70 + state.readUInt8(69) * 8;
  if (state.length < off + 1) return null;
  off += 1 + state.readUInt8(off) * 8;          // contracts
  if (state.length < off + 1) return null;
  off += 1 + state.readUInt8(off) * 4;          // selectors
  off += 1;                                      // recipient_arg
  if (state.length < off + 1) return null;
  const n = state.readUInt8(off);
  if (state.length < off + 1 + n) return null;
  return state.subarray(off + 1, off + 1 + n).toString("latin1");
}

function contractTermsFrom(state) {
  if (state.length < 70) return null;
  let off = 70 + state.readUInt8(69) * 8;
  if (state.length < off + 1) return null;

  const nContracts = state.readUInt8(off++);
  if (state.length < off + nContracts * 8 + 1) return null;
  const contracts = Array.from({ length: nContracts }, (_, i) =>
    `0.0.${state.readBigUInt64BE(off + i * 8)}`);
  off += nContracts * 8;

  const nSelectors = state.readUInt8(off++);
  if (state.length < off + nSelectors * 4 + 1) return null;
  const selectors = Array.from({ length: nSelectors }, (_, i) =>
    `0x${state.readUInt32BE(off + i * 4).toString(16).padStart(8, "0")}`);
  off += nSelectors * 4;

  const recipientArg = state.readUInt8(off);
  return {
    contracts,
    selectors,
    recipient_arg: recipientArg === 0xff ? null : recipientArg,
    // The sentence, not the field. "argument 1 must equal self" is true and
    // useless to anyone deciding whether to grant this.
    proceeds: nContracts === 0 || recipientArg === 0xff
      ? "no contract calls permitted"
      : "must return to this account",
  };
}

/** The mandate, read from the chip on every call — it can be revoked mid-run. */
async function envelope(slot = SLOT) {
  const state = await signer.transport
    .exchange(Buffer.from([0xe0, 0x10, slot, 0, 0]))
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
    label: labelFrom(state),
    payees: payeesFrom(state),
    calls: contractTermsFrom(state),
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
  "GET /envelope": async (req, res) => {
    const who = callerSlot(req, new URL(req.url, "http://localhost"));
    if (!who) return json(res, 401, { error: "unknown token" });
    const e = await envelope(who.slot);
    if (!e) {
      return json(res, 200, {
        slot: who.slot,
        agent: who.agent,
        mandate: null,
        note: "no mandate in this slot. Nothing can be paid until a human " +
              "grants one on the device. This is not an error you can retry past.",
      });
    }
    const a = advice();
    json(res, 200, {
      slot: who.slot,
      agent: who.agent,
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
    const who = callerSlot(req, new URL(req.url, "http://localhost"));
    if (!who) return json(res, 401, { error: "unknown token" });

    const body = await readBody(req);

    // A named service resolves here; a raw URL is the operator path. An agent
    // should use the name, and the catalogue is published at /services so it
    // can discover what there is without guessing.
    const target = body?.service ? SERVICES[body.service] : body?.url;
    if (!target) {
      return json(res, 400, {
        error: body?.service
          ? `no service named '${body.service}'`
          : 'give me {"service": "triage"}',
        services: Object.keys(SERVICES),
      });
    }

    const before = await envelope(who.slot);
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
    // The signer draws on whichever envelope the caller owns. Set here rather
    // than at construction because one gateway serves the whole fleet, and
    // the alternative — one signer per slot — would open three transports to
    // one device for no gain.
    signer.slot = who.slot;

    const client = new x402Client().register(NETWORK, new ExactHederaScheme(signer));
    // allowedAssets: true, not a cap. x402 applies spend controls by default
    // and HBAR is not one of its default assets, so leaving this unset does
    // not mean "no host-side limit" — it means every payment is rejected by
    // the client before the chip sees it.
    client.setSpendControls({ allowedAssets: true });
    const http = new x402HTTPClient(client);

    const first = await fetch(target).catch(() => null);
    if (!first) return json(res, 502, { error: `could not reach ${target}` });

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

    const paid = await fetch(target, { headers: http.encodePaymentSignatureHeader(payload) });
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
    const after = await envelope(who.slot);
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

  /**
   * Ask the chip to sign a contract call.
   *
   * Deliberately dumb about what the call means: it takes a contract and
   * calldata and forwards them. Every judgement about where that call sends
   * value is made in the Secure Element, reading the same bytes. A gateway
   * that second-guessed the calldata here would be adding a host-side check
   * in front of a hardware one, which is the pattern this project exists to
   * argue against.
   */
  "POST /call": async (req, res) => {
    const body = await readBody(req);
    if (!body?.contract || !body?.calldata) {
      return json(res, 400, { error: 'give me {"contract":"0.0.x","calldata":"0x…"}' });
    }

    const before = await envelope();
    if (!before) {
      return json(res, 200, { signed: false, refused: true, reason: "no_mandate",
                              terminal: true,
                              advice: "a human must grant an envelope on the device first" });
    }

    const calldata = Buffer.from(body.calldata.replace(/^0x/, ""), "hex");
    const amount = BigInt(body.amount ?? 0);
    const now = Math.floor(Date.now() / 1000);

    const head = Buffer.alloc(79);
    let o = 0;
    head.writeUInt8(SLOT, o); o += 1;
    for (const v of [
      7162784n,                                                  // fee payer
      BigInt(process.env.HEDERA_BUYER_ID.split(".")[2]),         // this device
      BigInt(String(body.contract).split(".").pop()),            // callee
      3n,                                                        // node
      amount,
      100_000_000n,                                              // max fee
      BigInt(body.gas ?? 120_000),
      BigInt(now),
    ]) { head.writeBigUInt64BE(v, o); o += 8; }
    head.writeUInt32BE(0, o); o += 4;
    head.writeUInt32BE(120, o); o += 4;
    head.writeUInt32BE(now, o); o += 4;
    head.writeUInt16BE(calldata.length, o);

    const payload = Buffer.concat([head, calldata]);
    try {
      const r = await signer.transport.exchange(
        Buffer.concat([Buffer.from([0xe0, 0x18, 0, 0, payload.length]), payload]));
      const bodyLen = r.readUInt16BE(12);
      // The encoded body comes back separately; see handler_authorize_call.
      const encoded = await signer.transport.exchange(
        Buffer.from([0xe0, 0x19, 0, 0, 0]));
      return json(res, 200, {
        signed: true,
        seq: r.readUInt32BE(0),
        remaining: String(r.readBigUInt64BE(4)),
        body_len: bodyLen,
        body: encoded.toString("hex"),
        note: "the chip built this body from fields it checked, and signed " +
              "bytes it constructed rather than bytes it was handed",
      });
    } catch (e) {
      const r = REFUSALS[e?.sw ?? e?.cause?.sw];
      if (r) {
        return json(res, 200, { signed: false, refused: true, ...r, envelope: before });
      }
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  },

  /**
   * Every slot the chip holds.
   *
   * Three, because that is what fits in the NVRAM the app is loaded with —
   * said plainly rather than presented as a design choice.
   */
  "GET /mandates": async (_req, res) => {
    const slots = [];
    for (let i = 0; i < 3; i++) {
      const e = await envelope(i).catch(() => null);
      slots.push(e ? { slot: i, ...e } : { slot: i, free: true });
    }
    json(res, 200, {
      slots,
      note: "read from the Secure Element. The host does not hold these " +
            "numbers and cannot correct them.",
    });
  },

  /**
   * Ask the device to revoke an envelope.
   *
   * The request does not revoke anything. It puts a question on the device's
   * screen and blocks until a human answers it with a finger — which is the
   * whole point, and the reason this endpoint is safe to expose to a console
   * that anyone on the machine can reach. A compromised host can ask. It
   * cannot answer.
   *
   * Only the operator path may call it. An agent revoking its own mandate
   * would be harmless; an agent revoking another's would not, and the
   * simplest way to have neither is to let no agent do it.
   */
  "POST /revoke": async (req, res) => {
    if (req.headers["authorization"]) {
      return json(res, 403, {
        error: "revocation is the operator's, not an agent's",
        advice: "call this without a bearer token, from the console",
      });
    }

    const body = await readBody(req);
    const slot = Number(body?.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot > 2) {
      return json(res, 400, { error: 'give me {"slot": 0}' });
    }

    const before = await envelope(slot).catch(() => null);
    if (!before) {
      return json(res, 200, { revoked: false, reason: "slot_already_free" });
    }

    try {
      await signer.transport.exchange(
        Buffer.concat([Buffer.from([0xe0, 0x14, 0, 0, 1]), Buffer.from([slot])]));
      return json(res, 200, {
        revoked: true,
        slot,
        was: before.label,
        note: "the envelope is gone from NVRAM. Nothing on any host had to " +
              "be rotated, and the agent's next draw fails at the chip.",
      });
    } catch (e) {
      // A refusal on the device is a person saying no, and reads the same as
      // a timeout from here. Both mean: not revoked, and say why plainly.
      return json(res, 200, {
        revoked: false,
        slot,
        reason: e?.sw ? `device answered 0x${e.sw.toString(16)}` : "no answer",
        advice: "the device asks before it forgets. Approve it on the screen.",
      });
    }
  },

  "GET /services": (_req, res) => {
    json(res, 200, {
      services: Object.keys(SERVICES),
      note: "invoke one by name with POST /pay {\"service\": \"triage\"}. " +
            "Naming the endpoint yourself would mean choosing who gets paid, " +
            "which is the field the mandate exists to control.",
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
