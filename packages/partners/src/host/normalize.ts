/**
 * The one hostname normaliser of the partner layer. Every place that turns a request host into a lookup key calls this, and
 * nothing else does the job: the middleware step, the branding route, the cache key and the signup hook.
 *
 * The rule is the one `partner_domains.hostname`'s CHECK states in migrations/0200_partners.sql: lowercase, no port, no
 * trailing dot, every label 1 to 63 characters of letters, digits and inner hyphens. `Partner.Example.COM.:443` becomes
 * `partner.example.com`. A value that cannot be put in that form (an IPv6 literal, a userinfo trick, a list of hosts, a path,
 * whitespace, an empty label) returns null, and the caller treats null as "not a partner host".
 *
 * The same pattern is compared with the migration text in test/normalize.test.ts, so the two cannot drift apart silently.
 */

/** The label shape of `partner_domains.hostname`'s CHECK in 0200. */
export const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
/** The longest legal name (RFC 1035). */
export const HOSTNAME_MAX_LENGTH = 253;

const PORT_SUFFIX = /:(\d{1,5})$/;

export function normalizeHostname(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > HOSTNAME_MAX_LENGTH + 8) return null;
  let host = raw;
  const port = PORT_SUFFIX.exec(host);
  if (port) {
    if (Number(port[1]) > 65535) return null;
    host = host.slice(0, port.index);
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  host = host.toLowerCase();
  if (host.length === 0 || host.length > HOSTNAME_MAX_LENGTH) return null;
  // Anything else (a comma-chained list, a second colon, a slash, an at sign, whitespace, a bracketed IPv6 literal, a second
  // trailing dot) fails the label pattern.
  return HOSTNAME_PATTERN.test(host) ? host : null;
}
