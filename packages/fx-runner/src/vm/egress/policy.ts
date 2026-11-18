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
/**
 * D#587 B-4a-ii: how the reverse endpoint serves a `rewritten` host. `forwardURL` (a validated plain https URL, no port) is where the request
 * goes, with the guest's path and query appended; `headers` is the transform, set on the upstream request over whatever the guest sent. A host
 * whose rules the reverse endpoint cannot apply faithfully (`match`, `response`, several rules, a rule with both a forward and a transform, a
 * header that is not one printable ASCII name/value pair) has NO route, so it stays refused everywhere.
 */
export interface ReverseRoute {
  readonly forwardURL?: URL;
  readonly headers: Readonly<Record<string, string>>;
}
export interface EgressPolicy {
  readonly hosts: ReadonlyMap<string, HostMode>;
  readonly routes: ReadonlyMap<string, ReverseRoute>;
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

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const HEADER_VALUE = /^[\x21-\x7e](?:[\x20-\x7e]{0,8190}[\x21-\x7e])?$/; // printable ASCII, inner spaces allowed ("Bearer k"), no edge spaces, no control bytes
/** Headers a transform may never set: they frame the message or name the destination, and the endpoint owns them. */
const FRAMING = new Set(["host", "content-length", "transfer-encoding", "connection", "upgrade", "te", "trailer", "expect", "proxy-authorization", "proxy-connection", "keep-alive"]);

function routeOf(rules: unknown[]): ReverseRoute | undefined {
  if (rules.length !== 1) return undefined;
  const rule = rules[0] as Record<string, unknown>;
  const keys = Object.keys(rule);
  if (keys.length !== 1) return undefined;
  if (keys[0] === "forwardURL") return { forwardURL: new URL(String(rule.forwardURL)), headers: {} };
  if (keys[0] !== "transform" || !Array.isArray(rule.transform)) return undefined;
  const headers: Record<string, string> = {};
  for (const entry of rule.transform) {
    if (!isObject(entry) || Object.keys(entry).some((k) => k !== "headers") || !isObject(entry.headers)) return undefined;
    for (const [name, value] of Object.entries(entry.headers)) {
      if (!HEADER_NAME.test(name) || FRAMING.has(name.toLowerCase()) || typeof value !== "string" || !HEADER_VALUE.test(value)) return undefined;
      headers[name.toLowerCase()] = value;
    }
  }
  return Object.keys(headers).length === 0 ? undefined : { headers };
}

function ruleMode(rules: unknown): { mode: HostMode; route?: ReverseRoute } {
  if (!Array.isArray(rules)) throw new PolicyRefused("a host's rules are not a list");
  for (const rule of rules) {
    if (!isObject(rule) || Object.keys(rule).some((k) => !RULE_KEYS.has(k))) throw new PolicyRefused("a rule has an unknown shape");
    if ("forwardURL" in rule) assertForwardUrl(rule.forwardURL);
  }
  if (rules.length === 0) return { mode: "direct" };
  const route = routeOf(rules);
  return route ? { mode: "rewritten", route } : { mode: "rewritten" };
}

export function parseEgressPolicy(value: unknown): EgressPolicy {
  if (value === "deny-all") return { hosts: new Map(), routes: new Map() };
  if (!isObject(value) || Object.keys(value).some((k) => k !== "allow")) throw new PolicyRefused("the policy shape is not one the proxy enforces");
  const allow = value.allow;
  const hosts = new Map<string, HostMode>();
  const routes = new Map<string, ReverseRoute>();
  if (allow === undefined) return { hosts, routes };
  if (Array.isArray(allow)) {
    for (const host of allow) hosts.set(plain(host), "direct");
  } else if (isObject(allow)) {
    for (const [host, rules] of Object.entries(allow)) {
      const name = plain(host);
      const { mode, route } = ruleMode(rules);
      hosts.set(name, mode);
      if (route) routes.set(name, route);
    }
  } else {
    throw new PolicyRefused("allow is neither a list nor a table");
  }
  return { hosts, routes };
}

/**
 * The default template policy (G4): the package registry is allowed, so `pnpm install --frozen-lockfile` in the guest reaches its tarballs.
 * Chosen over carrying a metadata cache in the image because a frozen-lockfile install still downloads every tarball: a metadata cache would
 * not remove the need for the registry. Only the public registry; no other host.
 */
export const DEFAULT_TEMPLATE_POLICY = Object.freeze({ allow: Object.freeze({ "registry.npmjs.org": Object.freeze([]) }) });
