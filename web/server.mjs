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
