/**
 * Deployment Protection, for the two sweep kicks and the verify health reader. A protected deployment answers an unauthenticated request with the platform's own 401 at
 * the edge, so a kick to the project's own public origin never reaches the function unless it carries the automation bypass. The secret may go ONLY to this project's
 * own hosts, decided from the platform's variables and matched exactly (case-folded, no wildcard, no suffix: `*.vercel.app` is shared with every customer, so a stale
 * or mistyped kick URL must never receive it). A header only, never in a URL, never with a bypass cookie.
 */
export const BYPASS_HEADER = 'x-vercel-protection-bypass';
const HOSTNAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

/** The secret, only when it is one value of printable characters (as the runner's own reader requires); anything else reads as unset. */
export function readBypassSecret(env: Record<string, string | undefined>): string | undefined {
  const v = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return v !== undefined && v.length > 0 && v.length <= 256 && /^[\x21-\x7e]+$/.test(v) ? v : undefined;
}

/** This project's own hostnames, from the platform's variables (bare hosts, no scheme) and the optional list. A value that is not a bare hostname is dropped. */
export function ownHosts(env: Record<string, string | undefined>): Set<string> {
  const out = new Set<string>();
  const raw = [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL, ...(env.FX_VERIFY_OWN_HOSTS ?? '').split(',')];
  for (const r of raw) {
    const h = (r ?? '').trim().toLowerCase();
    if (HOSTNAME.test(h) && h.includes('.') && !/^[0-9.]+$/.test(h)) out.add(h);
  }
  return out;
}

/** The secret to send to `url`, or undefined: set only when the secret is valid and the URL's hostname is exactly one of this project's own hosts. */
export function bypassSecretFor(url: URL, env: Record<string, string | undefined>): string | undefined {
  const secret = readBypassSecret(env);
  if (secret === undefined) return undefined;
  return ownHosts(env).has(url.hostname.toLowerCase()) ? secret : undefined;
}

/** After a kick's response: a non-2xx answer (the platform's protection page, a bad signature) is reported by status only. Never includes the secret. */
export function reportRefusedKick(response: { ok: boolean; status: number }, stage: string, reportError?: (err: unknown, stage: string) => void): void {
  if (!response.ok) reportError?.(new Error(`${stage} refused: status ${response.status}`), stage);
}
