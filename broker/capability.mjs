/**
 * Turning a capability and an agent's parameters into one upstream URL.
 *
 * Its own module because it is the security boundary of the broker and a
 * function nobody can call in isolation is a function nobody tests. Everything
 * here decides what an agent is allowed to make this process fetch while
 * holding a credential.
 */

/**
 * Build the upstream URL from the manifest template and validated params.
 *
 * Every placeholder must be filled, every supplied param must be declared,
 * and each value must match its declared pattern. Anything else is refused
 * before a secret is touched — an invalid request should never get far enough
 * to have a credential attached to it.
 *
 * The template lives in the manifest and never in the request. A broker that
 * accepted a URL and attached a credential to it would be a confused deputy
 * with an API key: the agent could point it at an internal service or an
 * attacker's collector, and it would dutifully authenticate the call.
 */
export function buildUrl(cap, params) {
  const declared = Object.keys(cap.params ?? {});
  for (const key of Object.keys(params ?? {})) {
    if (!declared.includes(key)) {
      throw new Error(`parameter '${key}' is not part of this capability`);
    }
  }
  let url = cap.url;
  for (const key of declared) {
    const value = params?.[key];
    if (value === undefined) throw new Error(`missing parameter '${key}'`);
    if (!new RegExp(cap.params[key]).test(String(value))) {
      throw new Error(`parameter '${key}' does not match ${cap.params[key]}`);
    }
    // Encoded, so a value that satisfies its pattern still cannot add a path
    // segment, a query string, or an authority.
    url = url.replaceAll(`{${key}}`, encodeURIComponent(String(value)));
  }
  if (/\{[a-z_]+\}/i.test(url)) {
    throw new Error("the capability template has an unfilled placeholder");
  }
  return url;
}

/**
 * A quota with no window is a quota that eventually bricks the agent.
 *
 * `risk.screen: 50` used to mean fifty calls ever. Nothing said over what
 * period, so every long-running agent walked toward a wall it could not see
 * and then stopped working — `research-1` hit it after a few days of ordinary
 * runs, and the refusal is indistinguishable from the agent being wrong about
 * something. Re-granting its mandate on the device did not help: the chip and
 * the broker count different things and neither knows about the other.
 *
 * The chip already solved this, one layer down, and the shape is worth
 * copying rather than inventing: a window and a cap. So a grant may be a bare
 * number, which still means "ever" and is what a one-shot capability wants,
 * or `{ limit, window_seconds }`, which means "this many, this often".
 *
 * The window is stored with the count rather than derived, for the same
 * reason the mandate stores `window_start`: a window that begins at the first
 * call of the period is a window an agent can shift by choosing when to
 * start, and one derived from the clock is a window that resets to full the
 * moment somebody changes it.
 */
export function quotaOf(grant) {
  if (grant == null) return null;
  if (typeof grant === "number") return { limit: grant, window: 0 };
  return { limit: Number(grant.limit ?? 0), window: Number(grant.window_seconds ?? 0) };
}

/** Calls used, and when the current window opened. Handles the old format. */
export function usageOf(used, key) {
  const v = used.get(key);
  if (v == null) return { count: 0, start: 0 };
  if (typeof v === "number") return { count: v, start: 0 };
  return { count: Number(v.count ?? 0), start: Number(v.start ?? 0) };
}

/** What this agent has spent of this grant *right now*. */
export function spentOf(used, key, quota, now = Math.floor(Date.now() / 1000)) {
  const u = usageOf(used, key);
  if (!quota?.window) return u;

  // No recorded start means usage written before windows existed. Carrying
  // the count and opening the window here is the conservative reading: the
  // agent keeps what it has spent and the clock starts now. Treating it as a
  // fresh window would hand every agent its quota back on the deploy that
  // introduced this, which is a refund nobody asked for and nobody would see.
  if (!u.start) return { count: u.count, start: now };

  // A host that winds its clock back does not get a fresh window. The chip
  // refuses this outright; here the honest equivalent is to keep counting.
  if (now < u.start) return u;
  if (now - u.start < quota.window) return u;
  return { count: 0, start: now };
}
