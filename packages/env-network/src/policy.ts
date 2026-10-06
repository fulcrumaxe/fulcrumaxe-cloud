import type { EnvSpec } from "@fx/env-spec";
import { EnvNetworkError } from "./errors.js";
import { normalizeHostname } from "./hostname.js";

/**
 * Hosts a customer can never list, each matched as itself or any subdomain: GitHub (github.com, which
 * covers api.github.com and codeload.github.com, and githubusercontent.com), and the two model gateway
 * hosts. Reaching GitHub goes only through our proxy; the model key is brokered onto the gateway rule.
 * The per-installation hosts (our GitHub proxy, the VCR registry) arrive in the context and are matched
 * exactly. Package registries are deliberately NOT reserved: the customer lists those.
 */
export const RESERVED_HOSTS: readonly string[] = Object.freeze([
  "github.com", "githubusercontent.com", "ai-gateway.vercel.sh", "api.anthropic.com",
]);

/**
 * The only hosts under the reserved GitHub apexes a customer can switch on, by listing the exact host in
 * `network.domains`. All are read-only download CDNs: archive tarballs, raw files, release assets and
 * container-registry blobs. They are emitted as platform-shaped `github_download` rules, never as
 * customer rules, and they never carry a credential.
 *
 * INVARIANT for the translation that turns this fragment into forwarding config (and for E9): our GitHub
 * forward rule must match github.com and api.github.com EXACTLY, never as a suffix, so that it cannot
 * capture codeload.github.com; and none of these hosts may ever be routed to our proxy, which holds
 * installation tokens. Nothing else under the reserved apexes is ever added here.
 */
export const GITHUB_DOWNLOAD_HOSTS: readonly string[] = Object.freeze([
  "codeload.github.com", "raw.githubusercontent.com", "objects.githubusercontent.com",
  "release-assets.githubusercontent.com", "pkg-containers.githubusercontent.com",
]);
const DOWNLOAD_SET: ReadonlySet<string> = new Set(GITHUB_DOWNLOAD_HOSTS);

const MODEL_HOST = { ai_gateway: "ai-gateway.vercel.sh", anthropic: "api.anthropic.com" } as const;
const MODEL_AUTH_HEADER = { ai_gateway: "Authorization", anthropic: "x-api-key" } as const;
export type ModelProvider = keyof typeof MODEL_HOST;

/** Same fields as packages/runner's `NetworkPolicyRule`; `customer_domain` is this package's one addition. */
export type NetworkPurpose = "model" | "github_proxy" | "github_download" | "customer_domain";
/** `host` is one exact hostname: never a wildcard, an address, a range or a port. */
export type NetworkRule =
  /** Only the `model` rule has `authHeader`: the header the firewall injects the brokered key under. */
  | { readonly host: string; readonly purpose: "model"; readonly authHeader: string }
  /** `github_download` (like every non-model rule) can never carry an auth header: the type forbids it. */
  | { readonly host: string; readonly purpose: "github_proxy" | "github_download" | "customer_domain"; readonly authHeader?: never };
export interface NetworkFragment {
  /** Anything not listed in `rules` is denied. */
  readonly default: "deny";
  readonly appliesAt: "creation";
  readonly rules: readonly NetworkRule[];
}
/** Platform facts for one run -- never customer input. */
export interface NetworkContext {
  readonly githubForwardHost: string;
  readonly modelProvider: ModelProvider;
  readonly vcrHost: string;
}

const isReserved = (host: string, exact: ReadonlySet<string>): boolean =>
  exact.has(host) || RESERVED_HOSTS.some((r) => host === r || host.endsWith(`.${r}`));

function platformHost(field: string, value: unknown): string {
  const n = normalizeHostname(value);
  if ("code" in n) throw new EnvNetworkError("invalid_context", `ctx.${field}`, "must be a plain hostname");
  return n.host;
}

/**
 * Turns `spec.network.domains` into the deny-by-default egress fragment for ONE run. It is meant to be
 * applied when the sandbox is CREATED: the platform default is allow-all, so a policy applied later (or
 * not at all) leaves the sandbox open. Our two platform rules come first and depend only on `ctx`; then any GITHUB_DOWNLOAD_HOSTS the customer listed; each
 * customer domain is added as an exact-host rule, and only ever widens this customer's own run. Any entry
 * that could defeat hostname filtering (a wildcard, an address, a range, a port, a reserved host) throws
 * an `EnvNetworkError` naming it rather than being dropped, cleaned up or merged.
 */
export function toPolicy(spec: EnvSpec, ctx: NetworkContext): NetworkFragment {
  if (!Object.hasOwn(MODEL_HOST, ctx.modelProvider)) throw new EnvNetworkError("invalid_context", "ctx.modelProvider", "is not a known provider");
  const forward = platformHost("githubForwardHost", ctx.githubForwardHost);
  const exact = new Set([forward, platformHost("vcrHost", ctx.vcrHost)]);
  const platform: NetworkRule[] = [
    { host: MODEL_HOST[ctx.modelProvider], purpose: "model", authHeader: MODEL_AUTH_HEADER[ctx.modelProvider] },
    { host: forward, purpose: "github_proxy" },
  ];
  const hosts = new Set<string>();
  const downloads = new Set<string>();
  for (const entry of spec.network?.domains ?? []) {
    const n = normalizeHostname(entry);
    const shown = typeof entry === "string" ? entry : "(not a string)";
    if ("code" in n) throw new EnvNetworkError(n.code, shown, "is not allowed: a hostname is required");
    if (!exact.has(n.host) && DOWNLOAD_SET.has(n.host)) { downloads.add(n.host); continue; }
    if (isReserved(n.host, exact)) {
      throw new EnvNetworkError("reserved_host", shown, `names the reserved host ${n.host}, which the platform provides; remove it. Switchable GitHub download hosts: ${GITHUB_DOWNLOAD_HOSTS.join(", ")}`);
    }
    hosts.add(n.host);
  }
  const download: NetworkRule[] = [...downloads].sort().map((host) => ({ host, purpose: "github_download" }));
  const customer: NetworkRule[] = [...hosts].sort().map((host) => ({ host, purpose: "customer_domain" }));
  return Object.freeze({ default: "deny", appliesAt: "creation", rules: Object.freeze([...platform, ...download, ...customer].map((r) => Object.freeze(r))) });
}
