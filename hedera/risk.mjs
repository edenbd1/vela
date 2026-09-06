/**
 * A counterparty risk feed.
 *
 * Stands in for the kind of service an operator actually pays for: a private
 * screening list, a sanctions feed, an internal credit view. Two properties
 * make it the right shape for a confidential workflow rather than an ordinary
 * one:
 *
 *   1. It needs a key. The key is the operator's, and a node operator running
 *      the workflow has no business seeing it.
 *   2. The *questions* are sensitive. Asking "is 0.0.10388937 still safe to
 *      pay" tells the listener which accounts an agent is authorised to pay,
 *      which is precisely the list an attacker would want in order to know
 *      where to aim. The allowlist leaks through the query pattern even if
 *      the answers are public.
 *
 * So both halves — the key and the questions — belong inside the enclave.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.RISK_PORT ?? 4040);
const KEY = process.env.RISK_API_KEY ?? "demo-risk-key";

// Deliberately small and legible. A real feed would be a database; what
// matters here is that the verdict is dynamic — it can turn against an
// account the chip's mandate still allows.
const FLAGGED = new Map([
  ["0.0.66666666", { score: 97, reason: "sanctioned counterparty" }],
  ["0.0.10365984", { score: 81, reason: "linked to a drainer cluster" }],
]);

// RISK_FLAG lets the demo turn the feed against an account that is genuinely
// being paid, which is the only way to show the interesting case: a payment
// the chip would still authorise, refused because the world changed. Nothing
// on the device moves — only the enclave's view of the counterparty.
if (process.env.RISK_FLAG) {
  for (const account of process.env.RISK_FLAG.split(",").map((x) => x.trim())) {
    if (account) {
      FLAGGED.set(account, { score: 88, reason: "adverse media, under review" });
    }
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.headers["x-api-key"] !== KEY) {
    res.writeHead(401, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "risk feed requires an api key" }));
  }

  const m = url.pathname.match(/^\/risk\/(.+)$/);
  if (!m) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "GET /risk/<account>" }));
  }

  const account = decodeURIComponent(m[1]);
  const hit = FLAGGED.get(account);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    account,
    score: hit ? hit.score : 3,
    reason: hit ? hit.reason : "no adverse signal",
    checked_at: new Date().toISOString(),
  }));
});

server.listen(PORT, () => {
  console.log(`risk feed on :${PORT}`);
  console.log(`  GET /risk/<account>   requires x-api-key`);
  console.log(`  flagged: ${[...FLAGGED.keys()].join(", ")}`);
});
