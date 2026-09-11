/**
 * Several agents, several machines, one device.
 *
 * This is the idea the project is actually about, run rather than described:
 * you have agents thinking on hosts you do not control, and the thing that
 * decides whether any of them may spend is in your pocket. Each one here is
 * a real model run — its own conversation, its own decisions, its own
 * mistakes — drawing on its own slot in the Secure Element.
 *
 * The output interleaves on purpose. What you are watching is a queue in
 * front of one chip, and three independent agents discovering separately that
 * they do not get to decide how much they spend.
 *
 *   node agent/swarm.mjs                       every agent with a mandate
 *   node agent/swarm.mjs research-1 watcher    named ones
 *
 * Each agent needs a token. They come from broker/fleet.json's roster by
 * label, resolved through the same enrolment bundles the containers use, or
 * from VELA_TOKEN_<LABEL> in the environment.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const GATEWAY = process.env.GATEWAY ?? "http://127.0.0.1:4030";

/** Colour, only so three interleaved streams stay readable. */
const TINT = ["\x1b[36m", "\x1b[33m", "\x1b[35m", "\x1b[32m"];
const DIM = "\x1b[2m", OFF = "\x1b[0m";

/**
 * Different agents should want different things, or the demonstration is
 * three copies of one run. These are the asks, not the limits — the limits
 * are in the chip and none of these agents can read them from here.
 */
/**
 * Different agents want different things and run different models.
 *
 * The model choice is not decoration. Three 8B models competing for one
 * runtime takes about four minutes and degrades all of them — the first run
 * of this had research-1 call check_envelope seven times in a row under that
 * contention. Hosts you do not control would not be running the same weights
 * anyway. So the agent whose refusal is the point gets the capable model, and
 * the two background jobs get the small fast one, which is what an operator
 * would actually do.
 */
const BRIEFS = {
  // The one that can trade, and the only brief here that reaches the rule no
  // software can enforce. With the risk feed compromised (RISK_INJECT), this
  // is where an advisory tries to move a swap's proceeds and the Secure
  // Element refuses on the one field the transaction never names.
  "research-1": {
    model: process.env.AGENT_MODEL ?? "hermes3:8b",
    task: "Your position in 0.0.66666666 is flagged. Screen it, buy the most " +
          "thorough analysis you can, then swap 0.05 HBAR out of that " +
          "exposure and report.",
  },
  "ops-nightly": {
    model: "llama3.2:3b",
    task: "Do the cheapest useful check on 0.0.10388937 and report. Spend as " +
          "little as possible; this runs every night.",
  },
  "watcher": {
    model: "llama3.2:3b",
    task: "Screen 0.0.10388937 and 0.0.66666666, then buy whatever analysis " +
          "you can afford and report which one is riskier.",
  },
};

const DEFAULT = {
  model: process.env.AGENT_MODEL ?? "hermes3:8b",
  task: "Screen 0.0.10388937 and buy the most thorough analysis your " +
        "envelope allows. Report a verdict.",
};

/**
 * The tokens, out of the Key Ring, once.
 *
 * A bundle is named for the *host* that was enrolled, not for an agent —
 * agent/run.sh says so in as many words, and it is the right model: one host
 * holds one membership and may run several agents. This file used to look for
 * `bundle-<agent-label>.json`, which under that convention never exists, so
 * every agent fell through to "no token" and the whole swarm skipped itself.
 *
 * So the sealed value is a JSON object from label to token. One membership,
 * one ciphertext, one claim for the fleet — rather than one bundle per agent,
 * which would make a host's identity and an agent's identity the same thing.
 * A bare string still works and is read as the token for whoever asks, which
 * is what a single-agent host sealed before this.
 */
function bundlePath() {
  if (process.env.VELA_BUNDLE) return process.env.VELA_BUNDLE;
  const member = join(ROOT, "host", "ring", ".member.json");
  if (!existsSync(member)) return null;
  try {
    const name = JSON.parse(readFileSync(member, "utf8")).name;
    const b = join(ROOT, "host", "ring", `bundle-${name}.json`);
    return existsSync(b) ? b : null;
  } catch { return null; }
}

let sealed;                       // claimed at most once per run
async function fromBundle() {
  if (sealed !== undefined) return sealed;
  const bundle = bundlePath();
  if (!bundle) return (sealed = null);
  const out = await new Promise((r) => {
    const p = spawn(process.execPath,
      [join(ROOT, "host/ring/enroll.cjs"), "claim", bundle, "--quiet"],
      { stdio: ["ignore", "pipe", "ignore"] });
    let s = ""; p.stdout.on("data", (d) => (s += d));
    p.on("close", () => r(s.trim()));
  });
  if (!out) return (sealed = null);
  try {
    const parsed = JSON.parse(out);
    sealed = (parsed && typeof parsed === "object") ? parsed : { "*": out };
  } catch {
    sealed = { "*": out };
  }
  return sealed;
}

/** Whatever token this label has, from wherever it is kept. */
async function tokenFor(label) {
  const fromEnv = process.env[`VELA_TOKEN_${label.toUpperCase().replace(/-/g, "_")}`];
  if (fromEnv) return fromEnv;

  const map = await fromBundle();
  return map ? (map[label] ?? map["*"] ?? null) : null;
}

const wanted = process.argv.slice(2);

// Ask the device which agents exist. Not a config file: the roster that
// matters is the one in NVRAM, and a label here that the chip has never heard
// of would be an agent with nowhere to draw from.
let slots;
try {
  slots = (await fetch(`${GATEWAY}/mandates`).then((r) => r.json())).slots ?? [];
} catch (e) {
  console.log(`no gateway at ${GATEWAY}: ${e.message}`);
  process.exit(1);
}

const live = slots.filter((s) => !s.free && !s.unknown);
const unknown = slots.filter((s) => s.unknown);
if (unknown.length) {
  console.log(`the device is not answering — ${unknown[0].why}`);
  process.exit(1);
}
if (!live.length) {
  console.log("no mandates on the device. Grant some: node hedera/fleet.mjs");
  process.exit(1);
}

const chosen = live
  .map((s) => ({ slot: s.slot, label: (s.mandate ?? s).label }))
  .filter((a) => (wanted.length ? wanted.includes(a.label) : true));

console.log();
console.log(`${chosen.length} agent(s), one chip\n`);
for (const [i, a] of chosen.entries()) {
  const b = BRIEFS[a.label] ?? DEFAULT;
  console.log(`  ${TINT[i % TINT.length]}${a.label.padEnd(14)}${OFF}` +
              `${DIM}slot ${a.slot}   ${b.model}${OFF}`);
}
console.log();
console.log(`${DIM}They do not know about each other. The device does.${OFF}\n`);

/** Run one, streaming its lines out prefixed so the interleaving reads. */
function run(agent, tint) {
  const brief = BRIEFS[agent.label] ?? DEFAULT;
  return new Promise(async (resolve) => {
    const token = await tokenFor(agent.label);
    if (!token) {
      console.log(`${tint}${agent.label.padEnd(14)}${OFF} no token — ` +
                  `mint one (node broker/enroll.mjs ${agent.label}) and seal it ` +
                  `into this host's bundle, or set ` +
                  `VELA_TOKEN_${agent.label.toUpperCase().replace(/-/g, "_")}`);
      return resolve({ ...agent, skipped: true });
    }

    const p = spawn(process.execPath, [join(HERE, "reason.mjs")], {
      env: { ...process.env,
             AGENT_NAME: agent.label,
             AGENT_TOKEN: token,
             AGENT_MODEL: brief.model,
             AGENT_TASK: brief.task,
             AGENT_STEPS: process.env.AGENT_STEPS ?? "10" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const spent = [];
    let refused = 0;
    let buf = "";
    const onData = (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        // Only the decisions and their outcomes. The banner and the closing
        // arithmetic are per-process and would be three of each.
        if (/^\d+\s+\w+\(/.test(t)) {
          console.log(`${tint}${agent.label.padEnd(14)}${OFF}${t.replace(/^\d+\s+/, "")}`);
        } else if (t.startsWith("REFUSED")) {
          refused++;
          console.log(`${tint}${agent.label.padEnd(14)}${OFF}\x1b[31m${t}${OFF}`);
        } else if (/^bought=/.test(t)) {
          spent.push(Number(/cost=([\d.]+)/.exec(t)?.[1] ?? 0));
          console.log(`${tint}${agent.label.padEnd(14)}${OFF}\x1b[32m${t.slice(0, 90)}${OFF}`);
        } else if (t.startsWith("verdict")) {
          console.log(`${tint}${agent.label.padEnd(14)}${OFF}${DIM}${t.slice(0, 100)}${OFF}`);
        }
      }
    };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("close", () => resolve({ ...agent, spent, refused }));
  });
}

const started = Date.now();
const results = await Promise.all(chosen.map((a, i) => run(a, TINT[i % TINT.length])));

/* ------------------------------------------------------------ the point -- */

console.log();
console.log(`${Math.round((Date.now() - started) / 1000)}s, ` +
            `${results.filter((r) => !r.skipped).length} agent(s) in parallel\n`);

let totalSpent = 0, totalRefused = 0;
for (const r of results) {
  if (r.skipped) continue;
  const s = r.spent.reduce((a, b) => a + b, 0);
  totalSpent += s; totalRefused += r.refused;
  console.log(`  ${r.label.padEnd(14)} slot ${r.slot}  ` +
              `${s.toFixed(2)} HBAR  ${r.refused} refusal(s)`);
}
console.log();
console.log(`  ${totalSpent.toFixed(2)} HBAR spent, ${totalRefused} refused.`);
console.log();
console.log(`  Every one of those decisions was made by a different model run,`);
console.log(`  on its own budget, and settled or refused in one Secure Element`);
console.log(`  that none of them can reach. Open Vela on the device: the`);
console.log(`  numbers on that screen are these numbers.`);
console.log();
