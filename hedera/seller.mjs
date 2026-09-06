/**
 * Two x402-gated endpoints on Hedera, at different prices.
 *
 * Two, not one, because a single priced endpoint does not make an agent
 * choose anything. With a cheap triage model and an expensive synthesis
 * model, an agent working under a fixed envelope has to decide what to spend
 * its remaining budget on — which is the behaviour the mandate exists to
 * bound.
 *
 *   node seller.mjs
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import express from "express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactHederaScheme } from "@x402/hedera/exact/server";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(ROOT, ".env") });

const PORT = Number(process.env.SELLER_PORT ?? 4021);
const NETWORK = "hedera:testnet";
/** HBAR is asset 0.0.0 in x402; amounts are tinybars, never floats. */
const HBAR = "0.0.0";

/**
 * payTo must be a real 0.0.x account — the facilitator rejects aliases.
 * It is the treasury: this side only ever receives.
 */
const PAY_TO = process.env.HEDERA_TREASURY_ID;
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL;

// Three tiers, spanning a mandate's per-payment ceiling rather than sitting
// under it. Two tiers that both fit never make an agent choose anything; a
// tier it cannot afford is what turns "check your envelope first" from
// advice into the difference between finishing and looping.
const TIER = {
  triage: { tinybars: "1000000", label: "0.01 HBAR", model: "triage" },
  synthesis: { tinybars: "8000000", label: "0.08 HBAR", model: "synthesis" },
  exhaustive: { tinybars: "15000000", label: "0.15 HBAR", model: "exhaustive" },
};

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitator).register(
  NETWORK,
  new ExactHederaScheme(),
);
// Pulls the fee payer out of the facilitator's /supported, so nothing about
// who pays Hedera's network fee is hardcoded here.
await resourceServer.initialize();

const app = express();

app.use(
  paymentMiddleware(
    {
      "GET /infer/triage": {
        accepts: {
          scheme: "exact",
          network: NETWORK,
          payTo: PAY_TO,
          price: { asset: HBAR, amount: TIER.triage.tinybars },
          maxTimeoutSeconds: 120,
        },
        description: "Fast, shallow pass over a market snapshot",
        mimeType: "application/json",
      },
      "GET /infer/synthesis": {
        accepts: {
          scheme: "exact",
          network: NETWORK,
          payTo: PAY_TO,
          price: { asset: HBAR, amount: TIER.synthesis.tinybars },
          maxTimeoutSeconds: 120,
        },
        description: "Deep pass — eight times the price of triage",
        mimeType: "application/json",
      },
      "GET /infer/exhaustive": {
        accepts: {
          scheme: "exact",
          network: NETWORK,
          payTo: PAY_TO,
          price: { asset: HBAR, amount: TIER.exhaustive.tinybars },
          maxTimeoutSeconds: 120,
        },
        description: "Everything we have — the most thorough answer available",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

app.get("/infer/:tier", (req, res) => {
  const tier = TIER[req.params.tier];
  res.json({
    model: tier.model,
    price: tier.label,
    verdict: tier.model === "triage"
      ? "nothing unusual"
      : "elevated funding risk on two venues",
    at: new Date().toISOString(),
  });
});

app.get("/health", (_req, res) => res.json({ ok: true, payTo: PAY_TO, network: NETWORK }));

app.listen(PORT, () => {
  console.log(`seller on :${PORT}`);
  console.log(`  network      ${NETWORK}`);
  console.log(`  payTo        ${PAY_TO}`);
  console.log(`  facilitator  ${FACILITATOR_URL}`);
  console.log(`  triage       ${TIER.triage.label}`);
  console.log(`  synthesis    ${TIER.synthesis.label}`);
  console.log(`  exhaustive   ${TIER.exhaustive.label}`);
});
