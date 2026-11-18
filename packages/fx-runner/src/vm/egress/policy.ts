import { assertPlainHost } from "../../sandbox/sandboxSettings.js";

/**
 * D#587 B-4a: a sandbox's `networkPolicy` (the SDK's `NetworkPolicy` value, as the cloud builds it in `sdkNetworkPolicy`) read into what the
 * egress proxy enforces. Every shape this file does not recognise is refused with an error, never skipped: a policy the proxy cannot read
 * must leave the sandbox with no egress, not with the part that parsed.
 *
 * - A host is a plain DNS name (the runner's `assertPlainHost`: no wildcard, no port, no address literal). Wildcards, subnets and `allow-all` are refused.
 * - A host with an empty rule list is `direct`: the proxy opens the tunnel to it after a checked resolve.
 * - A host with rules (`forwardURL`, `transform`, `response`, `match`) is `rewritten`. These rewrite the request, which a CONNECT tunnel cannot see,
 *   so they need TLS interception. The proxy has none, so it refuses every tunnel to such a host (reason `interception_required`) rather than let a
 *   forwarded host (GitHub, behind our proxy) or a keyed host (the model) be reached unrewritten. A `forwardURL` is still validated here.
 */
export type HostMode = "direct" | "rewritten";
export interface EgressPolicy {
  readonly hosts: ReadonlyMap<string, HostMode>;
}

export class PolicyRefused extends Error {
  constructor(what: string) {
    super(`egress policy refused: ${what}`);
    this.name = "PolicyRefused";
  }
}

const RULE_KEYS = new Set(["match", "transform", "forwardURL", "response"]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function plain(host: unknown): string {
  try {
    if (typeof host !== "string") throw new TypeError("not a string");
    return assertPlainHost(host);
  } catch {
    // fx-swallow-ok: replaced by a fixed refusal that does not echo the value
    throw new PolicyRefused("a host is not a plain DNS name");
  }
}

function assertForwardUrl(value: unknown): void {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    // fx-swallow-ok: replaced by a fixed refusal
    throw new PolicyRefused("a forwardURL is not a URL");
  }
  if (typeof value !== "string" || url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" || url.search !== "" || url.hash !== "") {
    throw new PolicyRefused("a forwardURL must be a plain https URL with no credentials, port, query or fragment");
  }
  plain(url.hostname);
}

function ruleMode(rules: unknown): HostMode {
  if (!Array.isArray(rules)) throw new PolicyRefused("a host's rules are not a list");
  for (const rule of rules) {
    if (!isObject(rule) || Object.keys(rule).some((k) => !RULE_KEYS.has(k))) throw new PolicyRefused("a rule has an unknown shape");
    if ("forwardURL" in rule) assertForwardUrl(rule.forwardURL);
  }
  return rules.length === 0 ? "direct" : "rewritten";
}

export function parseEgressPolicy(value: unknown): EgressPolicy {
  if (value === "deny-all") return { hosts: new Map() };
  if (!isObject(value) || Object.keys(value).some((k) => k !== "allow")) throw new PolicyRefused("the policy shape is not one the proxy enforces");
  const allow = value.allow;
  const hosts = new Map<string, HostMode>();
  if (allow === undefined) return { hosts };
  if (Array.isArray(allow)) {
    for (const host of allow) hosts.set(plain(host), "direct");
  } else if (isObject(allow)) {
    for (const [host, rules] of Object.entries(allow)) hosts.set(plain(host), ruleMode(rules));
  } else {
    throw new PolicyRefused("allow is neither a list nor a table");
  }
  return { hosts };
}

/**
 * The default template policy (G4): the package registry is allowed, so `pnpm install --frozen-lockfile` in the guest reaches its tarballs.
 * Chosen over carrying a metadata cache in the image because a frozen-lockfile install still downloads every tarball: a metadata cache would
 * not remove the need for the registry. Only the public registry; no other host.
 */
export const DEFAULT_TEMPLATE_POLICY = Object.freeze({ allow: Object.freeze({ "registry.npmjs.org": Object.freeze([]) }) });
