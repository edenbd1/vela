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

const PORT = Number(env.WEB_PORT ?? 4050);
const GATEWAY = `http://127.0.0.1:${env.GATEWAY_PORT ?? 4030}`;
const BROKER = `http://127.0.0.1:${env.BROKER_PORT ?? 4060}`;
const SELLER = `http://127.0.0.1:${env.SELLER_PORT ?? 4021}`;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

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
      topic: env.HEDERA_TOPIC_ID ?? null,
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
    const [mandates, roster] = await Promise.all([
      fetch(`${GATEWAY}/mandates`).then((r) => r.json()).catch(() => null),
      fetch(`${BROKER}/fleet`).then((r) => r.json()).catch(() => null),
    ]);

    const byLabel = new Map(
      (roster?.agents ?? []).map((a) => [a.label, a]),
    );

    const agents = (mandates?.slots ?? []).map((slot) => {
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

  // --- straight through to the gateway -----------------------------------
  if (path.startsWith("/api/")) {
    const target = `${GATEWAY}/${path.slice(5)}${url.search}`;
    try {
      const r = await fetch(target, {
        method: req.method,
        headers: req.method === "POST" ? { "content-type": "application/json" } : undefined,
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
});
