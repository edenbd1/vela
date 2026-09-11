/**
 * A capability broker.
 *
 * The thing Ledger's track asks for first: *"agents that use secrets they
 * cannot leak: a broker hands out scoped capabilities, never the API key."*
 *
 * An agent on a machine you do not control needs to call an authenticated
 * API. The usual answer is to copy the key onto that machine, which makes the
 * machine as valuable as the key and makes revocation a manual chore
 * somewhere else. Here the agent never receives a credential. It invokes a
 * *named action* and receives the *result*; the secret is decrypted under the
 * Ledger Key Ring for the duration of one upstream request and dropped.
 *
 * The design decision that matters is not the encryption. It is that a
 * capability names an action, and the URL lives in this manifest rather than
 * in the request.
 *
 * A broker that took a URL from the agent and attached a credential to it
 * would be a confused deputy with an API key: the agent could point it at
 * anything — an internal service, an attacker's collector — and the broker
 * would dutifully authenticate the request. So the agent supplies only
 * parameters, and only those the manifest declares, each matched against a
 * pattern before it reaches a template.
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { backingFor, reveal, PLAINTEXT, RING } from "./secrets.mjs";
import { buildUrl, quotaOf, spentOf } from "./capability.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BROKER_PORT ?? 4060);
/**
 * The roster, re-read on every use.
 *
 * It was loaded once at startup, which made revoking an agent a restart —
 * of this process *and* of the gateway, which reads the same file. Two
 * long-lived caches of one file are two caches that will disagree, and the
 * disagreement is silent: authenticated by one, mapped to the wrong slot by
 * the other. It is a few hundred bytes; reading it per request costs nothing
 * and means deleting a line takes effect immediately.
 */
const FLEET_FILE = join(HERE, "fleet.json");
const fleet = () => JSON.parse(readFileSync(FLEET_FILE, "utf8"));

/**
 * Calls made, keyed by agent and capability, and persisted.
 *
 * Held only in memory, a restart silently returned every agent to zero used —
 * which makes "granted 50 calls" a sentence rather than a limit, and the
 * failure is invisible because nothing looks wrong afterwards.
 */
const USAGE_FILE = join(HERE, "usage.json");
const used = new Map(Object.entries((() => {
  try { return JSON.parse(readFileSync(USAGE_FILE, "utf8")); } catch { return {}; }
})()));
const useKey = (agentId, cap) => `${agentId}:${cap}`;

function bump(key, next) {
  used.set(key, next);
  try {
    writeFileSync(USAGE_FILE, JSON.stringify(Object.fromEntries(used), null, 2) + "\n");
  } catch (e) {
    // Loud, because a quota that stops counting looks exactly like a quota
    // that is being respected.
    console.error(`  [usage] cannot persist ${USAGE_FILE}: ${e.message} — ` +
                  `quotas will reset on restart`);
  }
}

/**
 * Which agent is calling.
 *
 * A bearer token, and it is worth being exact about what that buys, because
 * the agent's own inventory claims it holds nothing sensitive.
 *
 * The token is not a credential in the sense that matters. It authenticates
 * *to this broker only*, it unlocks only the grants recorded for that one
 * agent, and it is revoked by deleting a line here. Stealing it gets you the
 * ability to screen accounts under someone else's quota; it does not get you
 * the risk feed's API key, which is what the agent would otherwise be
 * carrying.
 *
 * The honest upgrade is Key Ring membership rather than a shared string, and
 * that is what `wallet-cli ring init` on the agent's host replaces this with
 * once a device is available to enrol it.
 */
function identify(req) {
  const header = req.headers["authorization"] ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const digest = createHash("sha256").update(token).digest("hex");
  for (const [id, a] of Object.entries(fleet().agents)) {
    // Only the digest. A roster carrying plaintext tokens hands the whole
    // fleet to anyone who reads the file — and it was committed, so it handed
    // it to anyone who read the repository.
    if (a.token_sha256 && a.token_sha256 === digest) return { id, ...a };
  }
  return null;
}

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve(null); } });
  });

const routes = {
  /**
   * What *this* agent may invoke. Not the catalogue — its own grants.
   *
   * An agent that could read the whole catalogue would learn the shape of
   * every other agent's authority, which is not its business and is exactly
   * the sort of thing that turns one compromised host into a map.
   */
  "GET /capabilities": (req, res) => {
    const agent = identify(req);
    if (!agent) return json(res, 401, { error: "present a bearer token" });

    json(res, 200, {
      agent: agent.label,
      capabilities: Object.entries(agent.grants).map(([name, grant]) => ({
        name,
        description: fleet().capabilities[name]?.description ?? "unknown capability",
        params: Object.keys(fleet().capabilities[name]?.params ?? {}),
        // The count in the window that is open now, not the count ever, or
        // the agent reads a number it cannot act on.
        calls_used: spentOf(used, useKey(agent.id, name), quotaOf(grant)).count,
        calls_allowed: quotaOf(grant).limit,
        refills_every_seconds: quotaOf(grant).window || null,
        // Named so a demo cannot quietly claim hardware it did not use.
        secret_backing: backingFor(fleet().capabilities[name]?.secret) ?? "missing",
      })),
      note: "an agent invokes a named action and receives the result. " +
            "It never receives the credential, and it cannot choose the " +
            "endpoint the credential is sent to.",
    });
  },

  /**
   * The fleet, as the broker sees it.
   *
   * Deliberately not joined with the device here. The broker knows who is
   * enrolled and what they may invoke; the chip knows what it authorised.
   * Joining them is the console's job, and doing it here would mean this
   * host restating the chip's numbers as though it owned them.
   */
  "GET /fleet": (_req, res) => {
    json(res, 200, {
      agents: Object.entries(fleet().agents).map(([id, a]) => ({
        agent_id: id,
        label: a.label,
        slot: a.slot,
        grants: Object.entries(a.grants).map(([name, grant]) => ({
          name,
          limit: quotaOf(grant).limit,
          window_seconds: quotaOf(grant).window || null,
          used: spentOf(used, useKey(id, name), quotaOf(grant)).count,
        })),
      })),
      note: "what each agent may invoke. What each may spend is on the device.",
    });
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const key = `${req.method} ${url.pathname}`;

  if (routes[key]) return routes[key](req, res);

  const m = url.pathname.match(/^\/do\/(.+)$/);
  if (req.method !== "POST" || !m) {
    return json(res, 404, { error: "POST /do/<capability>, or GET /capabilities" });
  }

  const agent = identify(req);
  if (!agent) return json(res, 401, { error: "present a bearer token" });

  const name = decodeURIComponent(m[1]);
  const cap = fleet().capabilities[name];
  if (!cap) {
    return json(res, 404, { error: `no capability named '${name}'` });
  }

  // Granted to *this* agent, and the refusal says so without listing what
  // anyone else holds.
  const quota = quotaOf(agent.grants[name]);
  const limit = quota?.limit;
  if (quota === null) {
    return json(res, 200, {
      ok: false, refused: true, reason: "not_granted",
      advice: `'${agent.label}' has no grant for '${name}'`,
      granted: Object.keys(agent.grants),
    });
  }

  const quotaKey = useKey(agent.id, name);
  const window = spentOf(used, quotaKey, quota);
  const count = window.count;
  if (count >= limit) {
    return json(res, 200, {
      ok: false, refused: true, reason: "capability_exhausted",
      advice: quota.window
        ? `'${agent.label}' may call '${name}' ${limit} time(s) per ` +
          `${quota.window}s and has used them; it refills`
        : `'${agent.label}' was granted ${limit} calls of '${name}' and has used them`,
      terminal: !quota.window,
    });
  }

  let target;
  try {
    target = buildUrl(cap, (await readBody(req))?.params ?? {});
  } catch (e) {
    return json(res, 400, { ok: false, refused: true, reason: "bad_parameters",
                            advice: String(e.message) });
  }

  let secret;
  try {
    secret = await reveal(cap.secret);
  } catch (e) {
    return json(res, 503, { ok: false, reason: "secret_unavailable",
                            advice: String(e.message).slice(0, 200) });
  }
  if (secret.backing === PLAINTEXT) {
    console.warn(`  [plaintext] '${cap.secret}' is not under the Key Ring`);
  }

  try {
    const upstream = await fetch(target, {
      method: cap.method ?? "GET",
      headers: { [cap.header]: secret.value },
    });
    const body = await upstream.text();
    bump(quotaKey, { count: count + 1, start: window.start });

    json(res, 200, {
      ok: upstream.ok,
      agent: agent.label,
      capability: name,
      status: upstream.status,
      result: (() => { try { return JSON.parse(body); } catch { return body; } })(),
      calls_left: limit - (count + 1),
      secret_backing: secret.backing,
      note: "the credential was decrypted for this request and dropped. " +
            "It was never sent to the caller.",
    });
  } catch (e) {
    json(res, 502, { ok: false, reason: "upstream_unreachable",
                     advice: String(e.message).slice(0, 200) });
  } finally {
    // Not security — a live process can still be read — but it keeps the
    // window narrow and states the intent for anyone reading the code.
    secret.value = null;
  }
});

server.listen(PORT, () => {
  console.log(`vela broker on :${PORT}`);
  for (const [name, c] of Object.entries(fleet().capabilities)) {
    const b = backingFor(c.secret);
    const mark = b === RING ? "ring" : b === PLAINTEXT ? "PLAINTEXT" : "missing";
    console.log(`  capability ${name.padEnd(14)} secret: ${mark}`);
  }
  for (const a of Object.values(fleet().agents)) {
    console.log(`  agent ${a.label.padEnd(19)} slot ${a.slot}   ` +
                Object.entries(a.grants).map(([n, l]) => `${n}×${l}`).join(" "));
  }
  console.log(`\nagents invoke actions. They never receive a credential,`);
  console.log(`and they cannot choose where one is sent.`);
});
