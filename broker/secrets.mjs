/**
 * Where a secret lives, and who is allowed to see it.
 *
 * The answer is: encrypted on disk under a key derived by the Ledger Key
 * Ring, and nobody. Not the agent, which asks for actions rather than
 * credentials, and not this file, which holds a plaintext secret for the
 * duration of one upstream request and then drops it.
 *
 * `wallet-cli ring encrypt --key <name>` derives a *scoped* key per name, so
 * the ring itself carries the scoping: a member enrolled for `vela.risk-feed`
 * cannot read `vela.market-data`. That is a better boundary than a filesystem
 * permission, because it survives the filesystem being copied.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const STORE = join(HERE, "secrets");

/**
 * Development fallback, and it announces itself.
 *
 * `wallet-cli ring init` needs a physical device, so a plaintext store exists
 * to build against while one is unavailable. It is not a mode anyone should
 * reach by accident: the file extension is different, the server logs a
 * warning on every use, and `/capabilities` reports which backing store a
 * secret came from so the demo cannot quietly claim hardware it did not use.
 */
export const RING = "ring";
export const PLAINTEXT = "plaintext-dev";

export function backingFor(name) {
  if (existsSync(join(STORE, `${name}.enc`))) return RING;
  if (existsSync(join(STORE, `${name}.dev`))) return PLAINTEXT;
  return null;
}

/**
 * Fetch a secret for exactly one use.
 *
 * Returned as a string the caller is expected to drop. There is no cache: a
 * broker that keeps decrypted secrets in memory between requests is a broker
 * whose memory is worth stealing, and the whole argument for the Key Ring is
 * that there is nothing here worth taking away.
 */
export async function reveal(name) {
  const backing = backingFor(name);
  if (backing === null) {
    throw new Error(`no secret named ${name} — encrypt one into broker/secrets/`);
  }

  if (backing === PLAINTEXT) {
    return { value: readFileSync(join(STORE, `${name}.dev`), "utf8").trim(), backing };
  }

  // No password is passed here, and none is prompted for by this process.
  // Decryption uses the member credentials `wallet-cli ring init` left on this
  // machine. If the ring is not initialised the command fails, which is the
  // correct outcome: a broker that silently degrades to plaintext is worse
  // than one that refuses.
  const { stdout } = await run(
    "wallet-cli",
    ["ring", "decrypt", "--key", name, "-i", join(STORE, `${name}.enc`)],
    { encoding: "utf8", maxBuffer: 1 << 20 },
  );
  return { value: stdout.trim(), backing };
}
