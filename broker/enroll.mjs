/**
 * Mint an agent's token.
 *
 * The roster used to carry tokens in plaintext, committed. Anyone who read
 * the repository held every agent's credential — including the tokens printed
 * in agent/run.sh as a convenient default. Convenient, and a credential in
 * git history is a credential forever.
 *
 * So the roster stores a SHA-256 and the token is printed once, here, and
 * never written down by us. Losing it costs one re-enrolment; leaking the
 * roster costs nothing, which is the point.
 *
 *   node broker/enroll.mjs research-1
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, "fleet.json");

const label = process.argv[2];
if (!label) {
  console.error("usage: node broker/enroll.mjs <agent label>");
  process.exit(2);
}

const fleet = JSON.parse(readFileSync(FILE, "utf8"));
const entry = Object.entries(fleet.agents).find(([, a]) => a.label === label);
if (!entry) {
  console.error(`no agent labelled '${label}' in broker/fleet.json`);
  console.error(`known: ${Object.values(fleet.agents).map((a) => a.label).join(", ")}`);
  process.exit(1);
}

const [id, agent] = entry;
const token = randomBytes(24).toString("base64url");
agent.token_sha256 = createHash("sha256").update(token).digest("hex");
delete agent.token;                       // if an old plaintext one is still there
writeFileSync(FILE, JSON.stringify(fleet, null, 2) + "\n");

console.log(`\n  agent   ${label}  (slot ${agent.slot})`);
console.log(`  token   ${token}`);
console.log(`\n  Printed once. The roster now holds only its SHA-256, so this`);
console.log(`  file can be read by anyone without handing them the fleet.`);
console.log(`\n  AGENT_TOKEN=${token} ./agent/run.sh\n`);
