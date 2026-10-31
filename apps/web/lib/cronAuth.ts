import { timingSafeEqual } from "node:crypto";

/**
 * The one CRON_SECRET check every Vercel cron handler shares: `Authorization: Bearer <CRON_SECRET>`, constant-time, and an unset
 * secret or a missing header is refused outright (never compared), so an empty secret cannot match an empty header.
 *
 * A refusal logs one fixed JSON line, like the `cron.gate` lines: the event, the route and the reason. `missing` is no header or no
 * secret configured; `mismatch` is a header that differs. The line never carries the header, the secret, or anything derived from
 * them (not even a length), so a scheduler firing with the wrong secret shows up in the logs without leaking what it sent.
 */
export function cronAuthorized(route: string, authHeader: string | null, cronSecret: string): boolean {
  const reason = !cronSecret || !authHeader ? "missing" : matches(authHeader, cronSecret) ? null : "mismatch";
  if (reason) console.log(JSON.stringify({ event: "cron.refused", route, reason }));
  return reason === null;
}

function matches(authHeader: string, cronSecret: string): boolean {
  const expected = Buffer.from(`Bearer ${cronSecret}`, "utf8");
  const actual = Buffer.from(authHeader, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
