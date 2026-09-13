/**
 * The part a judge can actually see.
 *
 * Everything this project argues happens either inside a Secure Element or in
 * a terminal, and neither is watchable. The demonstration that matters — a
 * payment being refused by hardware — is a status word in a log. So this
 * serves a page where someone can press the button themselves and watch the
 * chip say no.
 *
 * A proxy rather than CORS on the gateway: the gateway is the agent-facing
 * API and should not grow browser concerns. Everything under /api is passed
 * through untouched, so what the page sees is exactly what an agent sees.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createRelay } from "./relay.mjs";
import { readFile, readFileSync } from "node:fs";
import { readFile as read } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

// No dotenv. This directory has no package.json and should not grow one for
// twelve lines — a static server with a node_modules is a static server
// someone has to keep patched. Last assignment wins, as dotenv does.
const env = (() => {
  const out = {};
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch { /* the page degrades to "no topic", which is honest */ }
  return { ...out, ...process.env };
})();

/** One variable, from .env as it is right now. See hedera/live-env.mjs. */
function liveEnv(key) {
  try {
    let found;
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && m[1] === key) found = m[2].trim();
    }
    return found ?? null;
  } catch { return null; }
}

const PORT = Number(env.WEB_PORT ?? 4050);
const GATEWAY = `http://127.0.0.1:${env.GATEWAY_PORT ?? 4030}`;
const BRIDGE  = `http://127.0.0.1:${env.VELA_BRIDGE_PORT ?? 8099}`;
const EXPECT_APP = env.VELA_BRIDGE_APP ?? "Vela";
const BROKER = `http://127.0.0.1:${env.BROKER_PORT ?? 4060}`;

/**
 * The seat the bridge normally occupies, kept warm for a browser.
 *
 * Nothing binds until a tab says it has the device, so this changes nothing
 * for anyone running host/bridge.py as usual.
 */
const relay = createRelay({
  port: Number(env.VELA_BRIDGE_PORT ?? 8099),
  journal: env.VELA_JOURNAL ?? join(ROOT, ".vela-journal.jsonl"),
});

/**
 * The operator credential, read fresh each time.
 *
 * The gateway mints one per run and writes it beside the repository. Reading
 * it per request rather than at startup means restarting the gateway does not
 * silently leave this console holding a token nobody accepts any more — which
 * would surface as "unknown token" on a page that has not changed.
 */
function operatorToken() {
  try {
    return readFileSync(join(ROOT, ".vela-operator-token"), "utf8").trim();
  } catch {
    return null;
  }
}
const SELLER = `http://127.0.0.1:${env.SELLER_PORT ?? 4021}`;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/**
 * What the fleet is thinking, wherever it is thinking it.
 *
 * The console cannot watch the agents: the whole point is that they run
 * somewhere else. So they report — `VELA_EVENTS` on an agent points at
 * POST /api/events here, and this holds the last few hundred and fans them
 * out to any open page.
 *
 * Deliberately not authenticated, and deliberately not trusted. An agent has
 * an agent token and no operator credential, so demanding one would mean
 * handing every agent the key to the console. Instead nothing here can *do*
 * anything: it is an append-only ring buffer that gets drawn as text. The
 * page renders it with textContent, so a hostile agent's best move is to
 * write something rude on a screen its operator is already looking at.
 *
 * The chip's numbers are never taken from here. Spending comes from
 * /api/fleet, which reads the Secure Element.
 */
const FEED_MAX = 400;
const feed = [];
const watchers = new Set();

function publish(event) {
  // A new run supersedes that agent's old one. Dropping the history here
  // rather than in the page keeps a browser opened mid-run from replaying
  // decisions that have already been replaced.
  if (event.kind === "start") {
    for (let i = feed.length - 1; i >= 0; i--) {
      if (feed[i].agent === event.agent) feed.splice(i, 1);
    }
  }
  const e = { ...event, seq: (feed.at(-1)?.seq ?? 0) + 1 };
  feed.push(e);
  if (feed.length > FEED_MAX) feed.shift();
  const line = `data: ${JSON.stringify(e)}\n\n`;
  for (const w of watchers) { try { w.write(line); } catch { watchers.delete(w); } }
}

/**
 * Is this account controlled by this key, according to Hedera?
 *
 * Cached for the life of the process: an account's key does not change under
 * a running console, and the device panel re-probes every eight seconds.
 * Returns null rather than false when the mirror node cannot be reached —
 * "we could not check" and "it does not match" are different answers and the
 * panel says so.
 */
const MIRROR = env.HEDERA_MIRROR ?? "https://testnet.mirrornode.hedera.com/api/v1";
const keyCache = new Map();
async function accountIsUnder(account, keyHex) {
  const at = `${account}/${keyHex}`;
  if (keyCache.has(at)) return keyCache.get(at);
  try {
    const r = await fetch(`${MIRROR}/accounts/${account}`,
                          { signal: AbortSignal.timeout(8000) });
    const k = (await r.json())?.key?.key;
    const out = typeof k === "string"
      ? k.toLowerCase().endsWith(keyHex.toLowerCase())
      : null;
    keyCache.set(at, out);
    return out;
  } catch {
    return null;
  }
}

const send = (res, code, type, body) => {
  res.writeHead(code, { "content-type": type });
  res.end(body);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // --- config the page needs but should not hardcode ---------------------
  if (path === "/api/config") {
    return send(res, 200, "application/json", JSON.stringify({
      seller: SELLER,
      // Re-read rather than served from the snapshot taken at startup: the
      // topic rotates whenever the fleet is granted, and a console linking to
      // a stale one sends a judge to an empty log.
      topic: liveEnv("HEDERA_TOPIC_ID") ?? env.HEDERA_TOPIC_ID ?? null,
      buyer: env.HEDERA_BUYER_ID ?? null,
      tiers: [
        { path: "/infer/triage", label: "triage", price: "0.01" },
        { path: "/infer/synthesis", label: "synthesis", price: "0.08" },
        { path: "/infer/exhaustive", label: "exhaustive", price: "0.15" },
      ],
      // Selectors are the first four bytes of keccak256 of the signature.
      // Spelled out so the page is checkable rather than trusted:
      //   swapExactHBARForTokens(uint256,address) -> f406a91a
      //   approve(address,uint256)                -> 095ea7b3
      defi: {
        swap: { selector: "f406a91a", sig: "swapExactHBARForTokens(uint256,address)" },
        approve: { selector: "095ea7b3", sig: "approve(address,uint256)" },
        attacker: "0.0.66666666",
        otherRouter: "0.0.5000002",
      },
    }));
  }

  /**
   * The operations the console may start.
   *
   * A fixed list, and the page names one of these keys rather than a command.
   * That is the same rule the broker enforces on capabilities and for the
   * same reason: a server that takes an argv from a client and runs it is a
   * confused deputy with a shell. Parameters are validated here, one pattern
   * each, and nothing else reaches the process.
   *
   * Everything here is something a person would otherwise type into a
   * terminal in the next room. None of it can move money on its own — the
   * grant needs a finger on the device, and every draw is checked in the chip
   * whatever this host thinks.
   */
  if (path === "/api/ops" && req.method === "POST") {
    const body = await new Promise((r) => {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b));
    });
    let ask;
    try { ask = JSON.parse(body || "{}"); } catch { ask = {}; }

    const LABEL = /^[a-z][a-z0-9-]{1,23}$/;
    const AMOUNT = /^\d{1,3}(\.\d{1,4})?$/;

    const OPS = {
      "grant": {
        title: "Grant an envelope",
        taps: 1,
        build: (a) => {
          if (!LABEL.test(a.label ?? "")) throw new Error("label: lowercase letters, digits and dashes");
          if (!AMOUNT.test(a.budget ?? "")) throw new Error("budget: a number of HBAR");
          if (!AMOUNT.test(a.ceiling ?? "")) throw new Error("ceiling: a number of HBAR");
          return ["node", ["hedera/grant-one.mjs", a.label, a.budget, a.ceiling]];
        },
      },
      "agent-here": {
        title: "Run an agent in a container",
        build: (a) => {
          // Named, not defaulted. This used to fall back to research-1 when
          // the caller said nothing, so the button ran an agent the page was
          // not pointing at — and the only sign was the wrong envelope going
          // down.
          if (!LABEL.test(a.agent ?? "")) throw new Error("name an agent to run");
          return ["./agent/run.sh", [], { AGENT_NAME: a.agent }];
        },
      },
      "swarm": {
        title: "Run the whole fleet",
        build: () => ["node", ["agent/swarm.mjs"],
                      { VELA_EVENTS: `http://127.0.0.1:${PORT}/api/events` }],
      },
      "tunnel-open": {
        title: "Put the gateway on a public URL",
        build: () => ["./scripts/remote-agent.sh", []],
      },
      "tunnel-close": {
        title: "Take it down",
        build: () => ["./scripts/remote-agent.sh", ["--stop"]],
      },
      // The tunnel, the dispatch and the run in one step. It used to be four
      // moves with an ngrok URL copied between two of them, which is a demo
      // that breaks on stage.
      "runner": {
        title: "Send an agent to GitHub's hardware",
        build: () => ["./scripts/runner-spend.sh", []],
      },
      "verify": {
        title: "Check the public log",
        build: () => ["node", ["hedera/verify.mjs"]],
      },
      "reconcile": {
        title: "Check the log against the chip",
        build: () => ["node", ["hedera/recover.mjs", "--check"]],
      },
    };

    const op = OPS[ask.op];
    if (!op) {
      return send(res, 400, "application/json",
        JSON.stringify({ error: `no operation named '${ask.op}'`,
                         operations: Object.keys(OPS) }));
    }

    let cmd, args, extra;
    try { [cmd, args, extra] = op.build(ask); }
    catch (e) { return send(res, 400, "application/json", JSON.stringify({ error: e.message })); }

    // Streamed, because these take between two seconds and five minutes and a
    // spinner that says nothing for five minutes is indistinguishable from a
    // hang. The device prompts arrive on this channel too.
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    res.write(`$ ${cmd} ${args.join(" ")}\n`);

    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, ...(extra ?? {}) },
    });
    child.stdout.on("data", (d) => res.write(d));
    child.stderr.on("data", (d) => res.write(d));
    child.on("error", (e) => { res.write(`\ncould not start: ${e.message}\n`); res.end(); });
    child.on("close", (code) => { res.write(`\n[exit ${code}]\n`); res.end(); });
    req.on("close", () => child.kill());
    return;
  }

  /**
   * Is there a device, and can it be used?
   *
   * Three different answers, and the page has to tell them apart because the
   * fix differs for each: the bridge is not running, the bridge is running
   * and the Flex is locked or unplugged, or the Flex is awake on the wrong
   * app. Collapsing them into "not connected" leaves the operator guessing
   * which of three things to go and do.
   *
   * `b001` is BOLOS's get-app-name, and it is the only call that answers
   * while an app other than ours is open — which is exactly the case worth
   * naming.
   */
  if (path === "/api/device") {
    const reply = (o) => send(res, 200, "application/json", JSON.stringify(o));
    let r;
    try {
      r = await fetch(`${BRIDGE}/apdu`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apdu: "b001000000" }),
        signal: AbortSignal.timeout(6000),
      });
    } catch {
      return reply({
        state: "no-bridge",
        why: "nothing is listening on the APDU bridge",
        fix: "connect the Flex from this page, or run python3 host/bridge.py",
      });
    }

    const body = await r.json().catch(() => ({}));
    if (body.error) {
      // Our own relay fails a call in flight when the tab holding the device
      // lets go. That is not a screen waiting for a finger, and telling
      // someone who just pressed Release to go and answer the Flex sends them
      // to look at a device that is asking nothing.
      if (!relay.held() && /holding the device/.test(body.error)) {
        return reply({
          state: "no-bridge",
          why: "the tab that was holding the Flex let go",
          fix: "connect the Flex from this page, or run python3 host/bridge.py",
        });
      }
      return reply({ state: "busy", why: body.error, fix: "answer or dismiss the screen on the Flex" });
    }
    if (!body.data) {
      return reply({
        state: "no-device",
        why: `the bridge is up but the device did not answer (sw 0x${(body.sw ?? 0).toString(16)})`,
        fix: "unlock the Flex and check the cable",
      });
    }

    // b001 replies: format, len, name…, len, version…
    const raw = Buffer.from(body.data, "hex");
    const nameLen = raw[1];
    const app = raw.subarray(2, 2 + nameLen).toString("latin1");
    const verLen = raw[2 + nameLen];
    const version = raw.subarray(3 + nameLen, 3 + nameLen + verLen).toString("latin1");

    if (app !== EXPECT_APP) {
      return reply({
        state: "wrong-app", app, version, expected: EXPECT_APP,
        why: `the Flex is on '${app}', not ${EXPECT_APP}`,
        fix: `open ${EXPECT_APP} on the device and stay on it`,
      });
    }
    // The key the chip holds, and whether the account this page names is
    // actually under it.
    //
    // `buyer` came out of .env — the host's claim about which account the
    // device controls, which is the one thing on this panel a host could just
    // be wrong about. The chip answers e016 with its own public key, and the
    // mirror node says which key each account is under, so the two can be put
    // side by side against a source that is neither of them.
    let key = null, keyMatches = null;
    try {
      const k = await fetch(`${BRIDGE}/apdu`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apdu: "e016000000" }),
        signal: AbortSignal.timeout(6000),
      }).then((x) => x.json());
      key = k.data || null;
      if (key && env.HEDERA_BUYER_ID) keyMatches = await accountIsUnder(env.HEDERA_BUYER_ID, key);
    } catch { /* the panel says what it knows; a missing key is not a failure */ }

    return reply({
      state: "ready", app, version, key, keyMatches,
      // Which of the two things behind :8099 answered. A console that said
      // "bridge" while a tab was doing the work would be lying about where
      // the device is, which is the one fact this panel exists to report.
      via: relay.held() ? "WebHID (a tab on this console)" : "host/bridge.py",
      buyer: env.HEDERA_BUYER_ID ?? null,
    });
  }

  /* ------------------------------------------------- the tab as bridge ----
   * A page that has opened the Flex over WebHID offers it to the rest of the
   * stack here, rather than keeping it to itself. See web/relay.mjs.
   */
  if (path === "/api/hid/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const held = await relay.hold(res, {
      app: url.searchParams.get("app"),
      version: url.searchParams.get("version"),
    });
    // The refusal goes down the same stream rather than as a status code:
    // EventSource does not hand the page a failed response body, and "why
    // not" is the whole value of the message.
    res.write(`event: ${held.ok ? "holding" : "refused"}\ndata: ${JSON.stringify(held)}\n\n`);
    if (!held.ok) return res.end();
    // A tab that navigates away or crashes releases the device. Without this
    // the port stays bound to nothing and the bridge cannot be restarted.
    req.on("close", () => relay.release());
    return;
  }

  if (path === "/api/hid/reply" && req.method === "POST") {
    let body = "";
    for await (const c of req) {
      body += c;
      if (body.length > 1 << 20) { req.destroy(); return; }
    }
    try {
      const ok = relay.reply(JSON.parse(body));
      return send(res, 200, "application/json", JSON.stringify({ ok }));
    } catch (e) {
      return send(res, 400, "application/json", JSON.stringify({ error: e.message }));
    }
  }

  /**
   * The fleet, joined.
   *
   * Two sources that are not the same kind of fact, and the join keeps them
   * apart rather than blending them into one row of numbers.
   *
   *   the chip    what each agent may spend, and has spent. It cannot be
   *               argued with, and the host does not hold these figures.
   *   the broker  what each agent may invoke. A file on a host, editable by
   *               whoever holds the host.
   *
   * This is a host, so it is allowed to be wrong, and the response says which
   * half came from where. A console that presented both as one authority
   * would be doing exactly what the device screen is careful not to do.
   */
  if (path === "/api/fleet") {
    const op = operatorToken();
    const [mandates, roster] = await Promise.all([
      fetch(`${GATEWAY}/mandates`, {
        headers: op ? { "x-vela-operator": op } : {},
      }).then((r) => r.json()).catch(() => null),
      fetch(`${BROKER}/fleet`).then((r) => r.json()).catch(() => null),
    ]);

    const byLabel = new Map(
      (roster?.agents ?? []).map((a) => [a.label, a]),
    );

    const agents = (mandates?.slots ?? []).map((slot) => {
      // A slot the device would not answer for is not an empty slot. Drawing
      // it as one would mean the console shows a fleet that has been wiped
      // when the device is merely closed — and a wiped fleet is also what a
      // successful revocation looks like.
      if (slot.unknown) return { slot: slot.slot, unknown: true, why: slot.why };
      if (slot.free) return { slot: slot.slot, free: true };
      const known = byLabel.get(slot.label);
      return {
        slot: slot.slot,
        // From the chip.
        label: slot.label,
        budget_total: slot.budget_total,
        available: slot.available,
        per_call_max: slot.per_call_max,
        draws: slot.draws_so_far,
        payees: slot.payees,
        // From the broker, and named as such.
        grants: known?.grants ?? null,
        agent_id: known?.agent_id ?? null,
        // What this agent is for, in a sentence. The roster's word, not the
        // chip's — a label like "research-1" tells a reader nothing, and the
        // console was asking people to pick between five of them.
        does: known?.does ?? null,
        // A mandate with no matching roster entry is not an error. It is an
        // agent the device authorised and this host has never heard of, which
        // is worth surfacing rather than hiding: the chip is the one that
        // cannot be edited.
        known_to_broker: Boolean(known),
      };
    });

    return send(res, 200, "application/json", JSON.stringify({
      agents,
      sources: {
        spending: mandates ? "chip" : "unreachable",
        capabilities: roster ? "broker" : "unreachable",
      },
      note: "spending figures come from the Secure Element and cannot be " +
            "corrected by this host. Capability grants come from the broker, " +
            "which is a host and can be.",
    }));
  }

  // --- what the fleet is thinking ----------------------------------------
  if (path === "/api/events" && req.method === "POST") {
    let body = "";
    for await (const c of req) {
      body += c;
      // A report is a few hundred bytes. Anything larger is not one.
      if (body.length > 8192) { req.destroy(); return; }
    }
    try {
      const e = JSON.parse(body);
      publish({
        agent: String(e.agent ?? "?").slice(0, 32),
        kind: String(e.kind ?? "?").slice(0, 16),
        model: String(e.model ?? "").slice(0, 40),
        step: Number(e.step) || null,
        tool: String(e.tool ?? "").slice(0, 32),
        call: String(e.call ?? "").slice(0, 64),
        thought: String(e.thought ?? "").slice(0, 240),
        reason: e.reason ? String(e.reason).slice(0, 40) : null,
        why: e.why ? String(e.why).slice(0, 200) : null,
        cost: e.cost ? String(e.cost).slice(0, 24) : null,
        left: e.left ? String(e.left).slice(0, 24) : null,
        summary: String(e.summary ?? "").slice(0, 200),
        verdict: String(e.verdict ?? "").slice(0, 300),
        // What a tool result told the agent to do. Quoted from a third party
        // by way of a language model, so it is the least trustworthy string
        // that reaches this page — and it is displayed with textContent for
        // exactly that reason.
        quote: String(e.quote ?? "").slice(0, 300),
        at: Date.now(),
      });
    } catch { /* a malformed report is dropped, not fatal */ }
    return send(res, 204, "text/plain", "");
  }

  // Everything the feed has seen, as a file. `node web/server.mjs > run.json`
  // is not how you get a recording — this is, and it captures exactly what the
  // page would have received, which is the only way a replay can be honest
  // about being one.
  if (path === "/api/events/recording") {
    // The fleet and the selected envelope go in with the events. A replay
    // that showed reasoning against empty budget cards would be showing half
    // a story, and the half it dropped is the one that comes from the chip.
    const [fleet, envelope] = await Promise.all([
      fetch(`http://127.0.0.1:${PORT}/api/fleet`).then((r) => r.json()).catch(() => null),
      fetch(`${GATEWAY}/envelope?slot=0`, {
        headers: operatorToken() ? { "x-vela-operator": operatorToken() } : {},
      }).then((r) => r.json()).catch(() => null),
    ]);
    return send(res, 200, "application/json", JSON.stringify({
      recorded: new Date().toISOString(),
      topic: liveEnv("HEDERA_TOPIC_ID"),
      fleet,
      envelope,
      events: feed,
    }, null, 2));
  }

  if (path === "/api/events/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    // Replay so a page opened mid-run is not blank.
    for (const e of feed.slice(-60)) res.write(`data: ${JSON.stringify(e)}\n\n`);
    watchers.add(res);
    req.on("close", () => watchers.delete(res));
    return;
  }

  // --- straight through to the gateway -----------------------------------
  if (path.startsWith("/api/")) {
    const target = `${GATEWAY}/${path.slice(5)}${url.search}`;
    try {
      const r = await fetch(target, {
        method: req.method,
        headers: {
          ...(req.method === "POST" ? { "content-type": "application/json" } : {}),
          // The console is the operator. It reads the credential the gateway
          // minted for this run, which a page on another site cannot.
          ...(operatorToken() ? { "x-vela-operator": operatorToken() } : {}),
          // Forward an agent's own token when the page is acting as one.
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        },
        body: req.method === "POST" ? await new Promise((ok) => {
          let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b));
        }) : undefined,
      });
      return send(res, r.status, "application/json", await r.text());
    } catch (e) {
      return send(res, 502, "application/json",
                  JSON.stringify({ error: `gateway unreachable: ${e.message}` }));
    }
  }

  // --- static ------------------------------------------------------------
  const file = path === "/" ? "/index.html" : path;
  const from = file.startsWith("/brand/") ? ROOT : HERE;
  try {
    const body = await read(join(from, file));
    send(res, 200, TYPES[extname(file)] ?? "application/octet-stream", body);
  } catch {
    send(res, 404, "text/plain", "not found");
  }
});

server.listen(PORT, () => {
  console.log(`vela web on http://127.0.0.1:${PORT}`);
  console.log(`  proxying /api/* to ${GATEWAY}`);
  console.log(`  agents report to POST /api/events — point them at it with:`);
  console.log(`    VELA_EVENTS=http://127.0.0.1:${PORT}/api/events`);
});
