import { GITHUB_DOWNLOAD_HOSTS, RESERVED_HOSTS, normalizeHostname, type NetworkFragment } from "@fx/env-network";

/** The two hosts our GitHub proxy forwards, matched exactly. */
const FORWARDED: ReadonlySet<string> = new Set(["github.com", "api.github.com"]);

/** The part of the runner's `NetworkPolicyRule` this needs; declared here so this package does not depend on the runner. */
interface RuleLike {
  readonly host: string;
  readonly purpose: string;
  readonly authHeader?: string;
}

/** The only purposes an environment adds. The model and GitHub proxy rules stay the runner's own. */
const ENV_PURPOSES: ReadonlySet<string> = new Set(["github_download", "customer_domain"]);

/**
 * The runner's firewall rules plus the environment's egress. The runner's rules are returned as the same objects, so
 * the brokered key on the model rule travels with them untouched; the fragment's own model and proxy rules are not
 * used (the runner built those from the tenant's real connection). An added rule is an exact host and nothing else:
 * no header, no match, no forward target. A host the platform already allows is refused rather than merged, so an
 * environment can never re-declare or shadow one of our rules.
 */
export function mergeEnvNetwork<R extends RuleLike>(base: readonly R[], fragment: NetworkFragment): R[] {
  const taken = new Set(base.map((r) => r.host));
  const added: R[] = [];
  for (const rule of fragment.rules) {
    if (!ENV_PURPOSES.has(rule.purpose)) continue;
    // Defence in depth: the fragment came from `toPolicy`, but each host is normalised and checked again here, so a
    // fragment built any other way cannot add a spelling of a reserved or proxy-forwarded host.
    const n = normalizeHostname(rule.host);
    if ("code" in n) throw new Error(`environment egress has a host that is not a plain hostname (${n.code})`);
    const host = n.host;
    const download = rule.purpose === "github_download" && GITHUB_DOWNLOAD_HOSTS.includes(host);
    if (!download && (FORWARDED.has(host) || RESERVED_HOSTS.some((r) => host === r || host.endsWith(`.${r}`)))) {
      throw new Error(`environment egress names ${host}, which the platform reserves`);
    }
    if (rule.purpose === "github_download" && !download) throw new Error(`environment egress names ${host} as a download host, which it is not`);
    if (taken.has(host)) throw new Error(`environment egress names ${host}, which the platform already allows`);
    taken.add(host);
    added.push({ host, purpose: rule.purpose } as R);
  }
  return [...base, ...added];
}
