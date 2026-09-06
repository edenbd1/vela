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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { backingFor, reveal, PLAINTEXT, RING } from "./secrets.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BROKER_PORT ?? 4060);
const CAPS = JSON.parse(readFileSync(join(HERE, "capabilities.json"), "utf8"));

/** Calls made per capability, this process. Crude, and enough to be real. */
const used = new Map();

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

/**
 * Build the upstream URL from the manifest template and validated params.
 *
 * Every placeholder must be filled, every supplied param must be declared,
 * and each value must match its declared pattern. Anything else is refused
 * before a secret is touched — the point is that an invalid request never
 * gets far enough to have a credential attached to it.
 */
function buildUrl(cap, params) {
  const declared = Object.keys(cap.params ?? {});
  for (const key of Object.keys(params ?? {})) {
    if (!declared.includes(key)) {
      throw new Error(`parameter '${key}' is not part of this capability`);
    }
  }
  let url = cap.url;
  for (const key of declared) {
    const value = params?.[key];
    if (value === undefined) throw new Error(`missing parameter '${key}'`);
    if (!new RegExp(cap.params[key]).test(String(value))) {
      throw new Error(`parameter '${key}' does not match ${cap.params[key]}`);
    }
    url = url.replaceAll(`{${key}}`, encodeURIComponent(String(value)));
  }
  if (/\{[a-z_]+\}/i.test(url)) {
    throw new Error("the capability template has an unfilled placeholder");
  }
  return url;
}

const routes = {
  /** What may be invoked, and on what backing. Never what the secret is. */
  "GET /capabilities": (_req, res) => {
    json(res, 200, {
      capabilities: Object.entries(CAPS).map(([name, c]) => ({
        name,
        description: c.description,
        params: Object.keys(c.params ?? {}),
        calls_used: used.get(name) ?? 0,
        calls_allowed: c.limit ?? null,
        // Named so a demo cannot quietly claim hardware it did not use.
        secret_backing: backingFor(c.secret) ?? "missing",
      })),
      note: "an agent invokes a named action and receives the result. " +
            "It never receives the credential, and it cannot choose the " +
            "endpoint the credential is sent to.",
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

  const name = decodeURIComponent(m[1]);
  const cap = CAPS[name];
  if (!cap) {
    return json(res, 404, { error: `no capability named '${name}'`,
                            available: Object.keys(CAPS) });
  }

  const count = used.get(name) ?? 0;
  if (cap.limit != null && count >= cap.limit) {
    return json(res, 200, {
      ok: false, refused: true, reason: "capability_exhausted",
      advice: `this capability allowed ${cap.limit} calls and has used them`,
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
    used.set(name, count + 1);

    json(res, 200, {
      ok: upstream.ok,
      capability: name,
      status: upstream.status,
      result: (() => { try { return JSON.parse(body); } catch { return body; } })(),
      calls_left: cap.limit == null ? null : cap.limit - (count + 1),
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
  for (const [name, c] of Object.entries(CAPS)) {
    const b = backingFor(c.secret);
    const mark = b === RING ? "ring" : b === PLAINTEXT ? "PLAINTEXT" : "missing";
    console.log(`  ${name.padEnd(16)} ${String(c.limit ?? "∞").padStart(3)} calls   secret: ${mark}`);
  }
  console.log(`\nagents invoke actions. They never receive a credential,`);
  console.log(`and they cannot choose where one is sent.`);
});
