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

/**
 * Open a new epoch, and record the topic it belongs to.
 *
 * The topic is here rather than left to .env because the two have to rotate
 * together or not at all. They did not: fleet.mjs made a new topic and
 * rewrote .env, a gateway that was already running kept anchoring to the old
 * one, and the result was a chain whose first draw was on one topic and whose
 * second was on another. The verifier read the new topic, found a draw
 * numbered 2 with no 1 in front of it, and correctly called it a gap — an
 * empty log while money was visibly moving, which is the worst possible thing
 * to find out during a demo.
 *
 * Binding them means a draw is anchored to the topic that was current when
 * its envelope was granted, which is the only reading under which "every
 * chain on this topic starts at 1" is true.
 */
export function openInstance(topic = null) {
  const id = now();
  writeFileSync(FILE, JSON.stringify({ id, topic }));
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
    const raw = readFileSync(FILE, "utf8").trim();
    if (raw) {
      // Older files hold a bare timestamp and no topic. Reading them rather
      // than minting a new epoch matters: a fresh epoch here would split the
      // chain of a mandate that is still live in the chip, which is the exact
      // failure this file exists to prevent.
      try {
        const o = JSON.parse(raw);
        if (o && typeof o === "object" && o.id) {
          return { id: String(o.id), topic: o.topic ?? null, minted: false };
        }
      } catch { /* not JSON: the old format */ }
      return { id: raw, topic: null, minted: false };
    }
  }
  return { id: openInstance(), topic: null, minted: true };
}
