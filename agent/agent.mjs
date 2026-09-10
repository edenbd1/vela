/**
 * An agent on a machine you do not control.
 *
 * It does authenticated work and it spends money, and there is nothing on
 * this host worth stealing. No API key: it invokes named actions on a broker
 * that holds the credential under the Ledger Key Ring. No private key: it
 * asks a gateway to pay, and the signature happens inside a Secure Element it
 * cannot reach.
 *
 * The demonstration is the inventory it prints before it starts. Everything
 * this process holds is two URLs and its own name. Copy this container
 * anywhere and it is worth exactly that.
 *
 *   BROKER=http://host.docker.internal:4060 \
 *   GATEWAY=http://host.docker.internal:4030 \
 *   node agent.mjs
 */
const BROKER = process.env.BROKER ?? "http://127.0.0.1:4060";
const GATEWAY = process.env.GATEWAY ?? "http://127.0.0.1:4030";
const NAME = process.env.AGENT_NAME ?? "research-1";

/**
 * The one thing this host does hold, and it is worth being exact.
 *
 * It authenticates to the broker and nowhere else, it unlocks only this
 * agent's own grants, and it is revoked by deleting a line in the broker's
 * roster. Stealing it buys the ability to burn one agent's quota; it does not
 * buy the risk feed's API key, which is what this process would otherwise be
 * carrying and what would have to be rotated everywhere.
 *
 * It no longer has to arrive in the clear. If this host has been enrolled in
 * the Key Ring, agent/run.sh takes the token out of a sealed bundle and
 * decrypts it here for the length of one run, using a key derived from
 * membership — see host/ring/enroll.cjs. That is the difference between a
 * shared string and a credential the trustchain can rotate away: eject the
 * host and the application key rotates, whatever bytes it kept.
 */
const TOKEN = process.env.AGENT_TOKEN ?? "";

const COUNTERPARTIES = (process.env.COUNTERPARTIES ??
  "0.0.10388937,0.0.66666666,0.0.10365984").split(",");

const j = (label, o) => console.log(`  ${label.padEnd(26)} ${o}`);

const auth = () => (TOKEN ? { authorization: `Bearer ${TOKEN}` } : {});

async function get(url) {
  const r = await fetch(url, { headers: auth() });
  return r.json();
}
async function post(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth() },
    body: JSON.stringify(body),
  });
  return r.json();
}

/* -------------------------------------------------- what this host holds -- */

console.log(`\nagent ${NAME}\n`);
console.log("everything on this machine:");
j("api keys", "none");
j("private keys", "none");
j("recovery phrase", "none");
j("broker token", TOKEN
    ? "one — scoped to this agent, revocable, useless elsewhere"
    : "none — the broker will refuse everything");
j("usb devices", "none — this is a container");
j("reachable", `${BROKER}  (actions)`);
j("", `${GATEWAY}  (payments)`);
console.log();

/* --------------------------------------------------------- what it may do -- */

const caps = await get(`${BROKER}/capabilities`).catch(() => null);
if (!caps) {
  console.log(`the broker is unreachable at ${BROKER}. Nothing to do.`);
  process.exit(1);
}
if (caps.error) {
  console.log(`the broker refused: ${caps.error}`);
  process.exit(1);
}
console.log("capabilities granted to it:");
for (const c of caps.capabilities) {
  const backing = c.secret_backing === "ring"
    ? "key ring"
    : c.secret_backing === "plaintext-dev"
      ? "PLAINTEXT (dev)"
      : c.secret_backing;
  j(c.name, `${c.calls_used}/${c.calls_allowed ?? "∞"} used · secret held by ${backing}`);
}

const env = await get(`${GATEWAY}/envelope`).catch(() => null);
const m = env?.mandate;
console.log(`\nspending envelope, read from the chip:`);
if (!m) {
  j("mandate", "none — a human must grant one on the device");
} else {
  j("available", `${Number(m.available) / 1e8} HBAR`);
  j("max per payment", `${Number(m.per_call_max) / 1e8} HBAR`);
  j("may pay", (m.payees ?? []).join(", "));
}

/* -------------------------------------------------------------- the work -- */

console.log(`\n1. screening ${COUNTERPARTIES.length} counterparties`);
console.log(`   using a credential this process has never seen\n`);

const screened = [];
for (const account of COUNTERPARTIES) {
  const r = await post(`${BROKER}/do/risk.screen`, { params: { account } });
  if (!r.ok) {
    j(account, `refused: ${r.reason ?? r.advice ?? "unknown"}`);
    continue;
  }
  screened.push({ account, ...r.result });
  j(account, `score ${r.result.score} — ${r.result.reason}`);
}

const clean = screened.filter((s) => s.score < 50);
const flagged = screened.filter((s) => s.score >= 50);

console.log(`\n2. ${clean.length} clean, ${flagged.length} flagged.`);
if (!m) {
  console.log("   no envelope, so nothing to buy. Stopping.\n");
  process.exit(0);
}

console.log(`   buying one triage inference to price the clean ones`);
console.log(`   the signature happens in a chip this host cannot reach\n`);

// A name, not an address. This process sees the seller at a container's
// view of the network, which is not a fact about the network — and choosing
// the endpoint would be choosing who gets paid.
const paid = await post(`${GATEWAY}/pay`, { service: "triage" });
if (paid.paid) {
  j("paid", `${Number(paid.spent) / 1e8} HBAR`);
  j("service said", paid.response?.verdict ?? "—");
  j("tx", paid.tx);
  j("left in the envelope", `${Number(paid.remaining) / 1e8} HBAR`);
  if (paid.anchored_as_message) j("anchored as message", `#${paid.anchored_as_message}`);
} else if (paid.refused) {
  // The chip said no. This is a decision, and it carries a reason the agent
  // can act on.
  j("the chip refused", paid.reason);
  j("why", paid.advice ?? "—");
  if (paid.terminal) j("retryable", "no — the chip is deterministic");
} else {
  // Nobody refused: the payment was authorised and then failed downstream.
  // Worth separating, because "you may not" and "it did not work" call for
  // opposite responses, and the reserved headroom has to come back either way.
  const why = paid.detail?.header?.errorMessage ?? paid.detail?.paymentStatus;
  j("not settled", paid.reason ?? "unknown");
  j("network said", why ? String(why).slice(0, 110) : "—");
  if (paid.released_as_message) {
    j("headroom released", `published as message #${paid.released_as_message}`);
  }
  if (String(why).includes("INVALID_SIGNATURE")) {
    console.log(`\n   INVALID_SIGNATURE here usually means the gateway is talking to`);
    console.log(`   Speculos while the account belongs to a physical device's key.`);
    console.log(`   The emulator signs correctly — for a different key.`);
  }
}

console.log(`\n3. done.`);
console.log(`   this host still holds no key and no credential.`);
console.log(`   revoke it by removing its ring membership, or its mandate,`);
console.log(`   and nothing here has to be rotated.\n`);
