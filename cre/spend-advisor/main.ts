/**
 * Vela spend advisor — a Chainlink CRE workflow that runs inside a TEE.
 *
 * Vela puts a spending mandate in a Ledger Secure Element: a human grants an
 * envelope once, and from then on the chip decides whether a payment **may**
 * happen. That boundary is hard and it is static. The chip has no clock beyond
 * an expiry, no network, and no opinion about the world — it cannot know that
 * an account which was reputable on Monday is a drainer by Friday.
 *
 * This workflow supplies that missing half. It decides whether a payment
 * **should** happen, and it does so somewhere the host cannot reach either.
 *
 * The composition rule, which is the whole point:
 *
 *   > The enclave can only ever narrow what the chip allows. It can never
 *   > widen it.
 *
 * A verdict from here removes a payee from consideration. It cannot add one,
 * raise a ceiling, or extend an envelope — those live in NVRAM behind a
 * hardware boundary, and nothing this workflow emits is an input to them. So
 * a compromised advisor costs availability, never authority. That asymmetry
 * is what makes it safe to let a network of node operators run it at all.
 *
 * Why the enclave, specifically. Two sensitive things meet in this handler:
 *
 *   - The risk feed's API key, which belongs to the operator and not to
 *     whichever node happens to pick up the trigger.
 *   - The mandate's allowlist. This one is easy to miss: even against a feed
 *     with public answers, the *questions* leak. A node that watches this
 *     workflow ask about four specific accounts has learned exactly which
 *     accounts an autonomous agent is authorised to pay — the shortlist an
 *     attacker would want in order to know where to aim. Confidential HTTP
 *     keeps the query pattern inside the enclave, not just the key.
 */
import {
  ConfidentialHTTPClient,
  CronCapability,
  handlerInTee,
  Runner,
  type TeeRuntime,
} from "@chainlink/cre-sdk";

export type Config = {
  schedule: string;
  /** The accounts the chip's mandate currently allows. */
  payees: string[];
  /** Base URL of the risk feed. */
  riskFeedUrl: string;
  /** Score at or above which a payee is withdrawn from consideration. */
  denyAtOrAbove: number;
};

export type PayeeVerdict = {
  payee: string;
  allow: boolean;
  score: number;
  reason: string;
};

export type Advice = {
  v: "vela.advice.v1";
  at: string;
  /** Payees the agent should stop paying, and why. */
  deny: PayeeVerdict[];
  /** Payees that still look fine. */
  allow: PayeeVerdict[];
  note: string;
};

const RISK_KEY_SECRET_ID = "RISK_API_KEY";

export const adviseOnSpending = (runtime: TeeRuntime<Config>): Advice => {
  const { payees, riskFeedUrl, denyAtOrAbove } = runtime.config;

  // Fetched inside the enclave. It is never handed to the node running this.
  const apiKey = runtime.getSecret({ id: RISK_KEY_SECRET_ID }).result().value;

  const client = new ConfidentialHTTPClient();

  // An enclave has no network egress of its own; reaching the risk feed means
  // going out through the DON. usingTheDons() is that door. Sending through
  // the *confidential* HTTP client is what stops the door from being a
  // window: the nodes relay the request without being able to read it, so
  // neither the key nor the account being asked about leaves the enclave in
  // the clear.
  const dons = runtime.usingTheDons();
  const verdicts: PayeeVerdict[] = [];

  for (const payee of payees) {
    // Confidential HTTP: the URL carries the account being asked about, so
    // this is the call that would otherwise leak the allowlist.
    // Passed as a literal rather than through the httpRequest() helper: the
    // capability's input type is a NoExcess generic that infers from the
    // literal, and a helper's widened return collapses every field to
    // undefined. Headers go in the proto's own multiHeaders shape.
    const response = client
      .sendRequest(dons, {
        request: {
          url: `${riskFeedUrl}/risk/${encodeURIComponent(payee)}`,
          method: "GET",
          multiHeaders: { "x-api-key": { values: [apiKey] } },
          encryptOutput: true,
        },
      })
      .result();

    const body = JSON.parse(new TextDecoder().decode(response.body));
    const score = Number(body.score ?? 0);

    verdicts.push({
      payee,
      allow: score < denyAtOrAbove,
      score,
      reason: String(body.reason ?? "no reason given"),
    });
  }

  const deny = verdicts.filter((v) => !v.allow);
  const allow = verdicts.filter((v) => v.allow);

  for (const v of deny) {
    runtime.log(`deny ${v.payee}: ${v.reason} (score ${v.score})`);
  }
  runtime.log(`advised on ${verdicts.length} payee(s); ${deny.length} denied`);

  return {
    v: "vela.advice.v1",
    at: new Date().toISOString(),
    deny,
    allow,
    note:
      "advisory only. This narrows the mandate held in the Secure Element; " +
      "it cannot widen it. A payee absent from the chip's allowlist is " +
      "refused in hardware whatever this says.",
  };
};

export const initWorkflow = (config: Config) => {
  const cron = new CronCapability();

  return [
    handlerInTee(
      cron.trigger({ schedule: config.schedule }),
      adviseOnSpending,
      // AWS Nitro. Region is pinned rather than left open so the attestation
      // being verified is one the operator actually chose.
      [{ tee: "nitro", regions: ["us-west-2"] }],
    ),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}

main();
