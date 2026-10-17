/**
 * D#598 P8a: the fixed vocabulary of setup requests. A request asks a person to do one step the platform cannot do for them. The kinds are a
 * closed list (a new one is a migration and a decision, never a string an agent may invent), a request carries no value field of any sort, and
 * the only link it may hold is a provider page on a fixed host.
 */

/** Every kind a row may hold (the database CHECK lists the same six). */
export const SETUP_REQUEST_KINDS = ['env_var', 'app_not_installed', 'parity_drift', 'parent_pr_closed', 'branch_pushed_by_person', 'overlay_path_missing'] as const;
export type SetupRequestKind = (typeof SETUP_REQUEST_KINDS)[number];

/** The kinds an agent may propose through the API. Public/private drift is recomputed from current state, never proposed. */
export const AGENT_PROPOSABLE_KINDS = ['env_var', 'app_not_installed', 'parent_pr_closed', 'branch_pushed_by_person', 'overlay_path_missing'] as const satisfies readonly SetupRequestKind[];
export type AgentProposableKind = (typeof AGENT_PROPOSABLE_KINDS)[number];

/** The only automatic check a request may name so far. It reads an environment variable's NAME on a Vercel project, never its value. */
export const SETUP_REQUEST_CHECK_KINDS = ['env_var_present'] as const;
export type SetupRequestCheckKind = (typeof SETUP_REQUEST_CHECK_KINDS)[number];

export const SETUP_REQUEST_STATES = ['open', 'done', 'withdrawn'] as const;
export type SetupRequestState = (typeof SETUP_REQUEST_STATES)[number];

/** Hosts a request's provider link may point at (https, no credentials, no port). */
export const PROVIDER_LINK_HOSTS = ['github.com', 'vercel.com'] as const;

export const TARGET_MAX_CHARS = 200;
export const REASON_MAX_CHARS = 1000;
export const CHECK_REASON_MAX_CHARS = 300;
const PROVIDER_URL_MAX_CHARS = 500;

/** Same pattern as the database CHECK on `env_name`: the variable's name, nothing else. */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
/** Control characters other than a tab or a line break in a reason; and any at all in a target. */
const REASON_CONTROL_RE = /[\u0001-\u0008\u000B-\u001F\u007F]/;
const SHORT_CONTROL_RE = /[\u0001-\u001F\u007F]/;
const URL_BAD_CHAR_RE = /[\s\\\u0000-\u001F\u007F]/;
const PROVIDER_URL_DB_RE = /^https:\/\/(github\.com|vercel\.com)(\/[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]*)?$/;

export function isSetupRequestKind(value: unknown): value is SetupRequestKind {
  return typeof value === 'string' && (SETUP_REQUEST_KINDS as readonly string[]).includes(value);
}
export function isAgentProposableKind(value: unknown): value is AgentProposableKind {
  return typeof value === 'string' && (AGENT_PROPOSABLE_KINDS as readonly string[]).includes(value);
}

/** A name a person reads: 1..200 characters, no control characters. */
export function isValidTarget(value: string): boolean {
  return value.length >= 1 && value.length <= TARGET_MAX_CHARS && !SHORT_CONTROL_RE.test(value);
}
/** Plain text for a person: 1..1000 characters, line breaks allowed, other control characters not. Markup and URLs are allowed and stay literal text. */
export function isValidReason(value: string): boolean {
  return value.length >= 1 && value.length <= REASON_MAX_CHARS && !REASON_CONTROL_RE.test(value);
}

/**
 * The link a request may carry: an https page on one of {@link PROVIDER_LINK_HOSTS}, with no credentials, no port and no whitespace or
 * backslash. Returns the normalised address, or null when the value is not acceptable. The database CHECK holds the same rule.
 */
export function normalizeProviderUrl(value: string): string | null {
  if (value.length === 0 || value.length > PROVIDER_URL_MAX_CHARS || URL_BAD_CHAR_RE.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // fx-swallow-ok: an address that does not parse is simply not an acceptable link
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return null;
  if (!(PROVIDER_LINK_HOSTS as readonly string[]).includes(url.hostname)) return null;
  const text = url.toString();
  // Anything URL parsing had to re-encode or that the database pattern would refuse is refused here, so the two never disagree.
  return PROVIDER_URL_DB_RE.test(text) ? text : null;
}

/**
 * The words a person sees for a request, built from fixed templates around the target: a list shows this, never the agent's reason as a
 * heading. The first four use the sentences the Spec approves; the last two have no approved sentence yet (listed for owner approval in the PR).
 */
export function setupRequestTitle(kind: SetupRequestKind, target: string, envName: string | null): string {
  switch (kind) {
    case 'app_not_installed':
      return `App not installed on ${target}`;
    case 'branch_pushed_by_person':
      return `Someone pushed to ${target}`;
    case 'overlay_path_missing':
      return `Add ${target} to the overlay paths`;
    case 'parent_pr_closed':
      return 'Parent PR closed';
    case 'env_var':
      return `Add the environment variable ${envName ?? target} to ${target}`;
    case 'parity_drift':
      return `Public and private code differ: ${target}`;
  }
}
