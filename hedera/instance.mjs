// The grant epoch.
//
// A mandate's digest covers its terms, not its lifetime. Grant the same terms
// twice — same agent, same budget, same payee — and you get the same digest
// while the chip's counter restarts at 1. A verifier reading the topic sees
// one envelope whose sequence goes 1,2,3,1,2 and calls it a gap, which is the
// right conclusion from the wrong premise: those are two envelopes, not one
// with holes.
//
// So every grant opens an epoch, and every draw carries it. The chip cannot
// attest this — a never-expiring mandate has no creation time in its state —
// so it is host bookkeeping, and it is written down where every script that
// draws on the same live mandate can find it. Splitting the chain is all it
// has to do; a host that lies about it only fragments its own audit log.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", ".vela-instance");

const now = () => String(Math.floor(Date.now() / 1000));

/** Open a new epoch. Call this immediately after a grant is approved. */
export function openInstance() {
  const id = now();
  writeFileSync(FILE, id);
  return id;
}

/**
 * The epoch of the mandate now living in the chip.
 *
 * Missing means the mandate outlived the file, or was granted by something
 * that did not record one. Minting a fresh epoch is the honest answer: these
 * draws belong to a lifetime this host cannot name, and giving them their own
 * bucket is better than filing them under a constant that every other unknown
 * run also used.
 */
export function currentInstance() {
  if (existsSync(FILE)) {
    const id = readFileSync(FILE, "utf8").trim();
    if (id) return { id, minted: false };
  }
  return { id: openInstance(), minted: true };
}
