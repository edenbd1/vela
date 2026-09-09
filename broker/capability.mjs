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
