import net from 'node:net';
import { isBlockedAddress, resolveChecked, NetGuardError, type HostLookup } from '@fx/net-guard';

/**
 * D#31 API-4b, criteria 1 and 2. Reuses `@fx/net-guard`'s
 * `isBlockedAddress`/`resolveChecked` (D#66, D#31's exact blocked-range
 * list) rather than a second copy -- see that package's own header,
 * which already names this file as one of its two callers.
 *
 * Two separate checks, on purpose:
 *   - `validateWebhookUrlSyntax` (criterion 1, registration time): pure
 *     and synchronous. Catches an IP literal (in any of the obfuscated
 *     forms WHATWG `URL` itself normalizes -- decimal/octal/hex IPv4,
 *     bracketed IPv6, IPv4-mapped IPv6) and a small denylist of hostnames
 *     that resolve publicly but are never a legitimate customer
 *     destination (our own infrastructure).
 *   - `resolveDeliveryAddresses` (criterion 2, delivery time): the live
 *     DNS check, called again on every send (registration-time DNS can
 *     go stale) and PINNED by the caller (connector.ts) to the exact
 *     address this function already validated -- never re-resolved
 *     between the check and the connect.
 */

export type WebhookUrlReasonClass =
  | 'invalid_url'
  | 'scheme'
  | 'port'
  | 'userinfo'
  | 'url_too_long'
  | 'blocked_hostname'
  | 'blocked_address'
  | 'dns_failed';

export class InvalidWebhookUrlError extends Error {
  constructor(
    public readonly reasonClass: WebhookUrlReasonClass,
    message?: string,
  ) {
    super(message ?? `invalid webhook url (${reasonClass})`);
    this.name = 'InvalidWebhookUrlError';
  }
}

/** "A URL over 2,048 characters" (criterion 1). */
export const MAX_WEBHOOK_URL_LENGTH = 2048;

/**
 * Criterion 1's named hostname examples: `localhost`, `a.local`,
 * `a.internal`, `*.fulcrumaxe.dev` and "our Vercel hosts". Not exhaustive
 * against every internal name a determined attacker might try --
 * `resolveDeliveryAddresses` (criterion 2) is the real backstop, since it
 * classifies the RESOLVED address regardless of what the hostname is.
 * This list exists so an obviously-wrong destination is rejected
 * immediately at registration, with no network round trip.
 */
const BLOCKED_HOSTNAME_EXACT = new Set(['localhost']);
const BLOCKED_HOSTNAME_SUFFIXES = ['.local', '.internal', '.fulcrumaxe.dev', '.vercel.app', '.vercel-insights.com'];

function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTNAME_EXACT.has(lower)) return true;
  return BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => lower === suffix.slice(1) || lower.endsWith(suffix));
}

/** Strips the `[` `]` WHATWG `URL#hostname` wraps an IPv6 literal in --
 * `net.isIP`/`isBlockedAddress` both expect the bare literal. */
function unbracket(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * Criterion 1. Throws `InvalidWebhookUrlError` with the reason class the
 * Spec asks for; returns the parsed `URL` (so a caller doesn't have to
 * re-parse) on success.
 */
export function validateWebhookUrlSyntax(rawUrl: string): URL {
  if (rawUrl.length > MAX_WEBHOOK_URL_LENGTH) {
    throw new InvalidWebhookUrlError('url_too_long');
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new InvalidWebhookUrlError('invalid_url');
  }
  if (url.protocol !== 'https:') {
    throw new InvalidWebhookUrlError('scheme');
  }
  if (url.username || url.password) {
    throw new InvalidWebhookUrlError('userinfo');
  }
  if (url.port && url.port !== '443') {
    throw new InvalidWebhookUrlError('port');
  }

  const hostname = unbracket(url.hostname);
  // WHATWG URL parsing already canonicalizes a numeric-looking hostname
  // (decimal/octal/hex IPv4 -- "2130706433", "0x7f000001", "017700000001"
  // all become "127.0.0.1") and an IPv4-mapped IPv6 literal into its
  // hex-group form ("::ffff:127.0.0.1" -> "::ffff:7f00:1") -- so this
  // sees the REAL address an obfuscated spelling encodes, not the
  // attacker's original text.
  if (net.isIP(hostname) !== 0) {
    if (isBlockedAddress(hostname)) {
      throw new InvalidWebhookUrlError('blocked_address');
    }
    return url;
  }
  if (isBlockedHostname(hostname)) {
    throw new InvalidWebhookUrlError('blocked_hostname');
  }
  return url;
}

/**
 * Criterion 2. Resolves `hostname` through `@fx/net-guard`'s
 * `resolveChecked` and returns every validated address -- the caller
 * (connector.ts) picks and PINS its socket to exactly one of these,
 * never re-resolving. `lookup` is the same injectable-DNS seam
 * `resolveChecked` already defines, threaded through so tests never make
 * a real DNS query.
 */
export async function resolveDeliveryAddresses(hostname: string, lookup?: HostLookup): Promise<string[]> {
  try {
    return await resolveChecked(unbracket(hostname), lookup);
  } catch (err) {
    if (err instanceof NetGuardError) {
      throw new InvalidWebhookUrlError(err.code === 'blocked_address' ? 'blocked_address' : 'dns_failed', err.message);
    }
    throw err;
  }
}
