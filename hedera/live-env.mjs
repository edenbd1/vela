/**
 * Values that can change under a running process.
 *
 * `dotenv` reads .env once, into process.env, at import. That is right for
 * almost everything here — an operator key does not change while the gateway
 * is up. It is wrong for the audit topic, because `hedera/fleet.mjs` creates
 * a new one every time it grants, and rewrites .env to say so. A gateway
 * started before that keeps anchoring to the topic it was born with.
 *
 * Which is exactly what happened: three agents paid, the chip's numbers
 * moved, and `node hedera/verify.mjs` reported "no draws anchored yet"
 * against the topic .env now names. The chain was intact — on a topic nobody
 * was looking at any more. In a demo that is a verifier showing an empty log
 * while money is visibly moving, which is the worst possible moment to
 * discover it.
 *
 * This is the fourth time a value frozen at startup has caused a bug in this
 * project (the broker's roster, the agent roster in two processes, hardcoded
 * accounts in the tests). The rule that keeps emerging: anything another
 * process can rewrite has to be read when it is used, not when the reader
 * started.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENV_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");

/**
 * Read one variable from .env as it is right now.
 *
 * Falls back to process.env, so an explicit override in the environment still
 * wins — a deployment that sets HEDERA_TOPIC_ID directly should not have it
 * silently replaced by whatever a file on disk says. Last assignment wins
 * within the file, as dotenv does.
 */
export function live(key, fallback = process.env[key]) {
  let found;
  try {
    for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && m[1] === key) found = m[2].trim();
    }
  } catch {
    return fallback;
  }
  return found ?? fallback;
}

/**
 * The audit topic, now.
 *
 * Its own function because it is the one value in this project with a
 * lifetime shorter than a process, and naming it makes the call sites read
 * as the deliberate choice they are.
 */
export const liveTopic = () => live("HEDERA_TOPIC_ID");
