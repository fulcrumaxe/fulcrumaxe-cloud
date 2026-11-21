import { isIP } from "node:net";

/** The only header the binding reads. Vercel's edge sets it to the connecting address and overwrites any value a caller sends. */
export const BOUND_SOURCE_IP_HEADER = "x-vercel-forwarded-for";

/**
 * The address a request really came from, for deciding a token-to-IP binding (D#845 MC-5, S-2). It is deliberately NOT `clientIpFromRequest`:
 * that one also trusts `x-real-ip` and `x-forwarded-for`, which a caller can set on any host the platform does not overwrite them on, and it falls
 * back to a shared "unknown" bucket. This reads the platform-set header alone and fails closed: a missing header, a list, or anything that is not
 * one literal address gives undefined, and the caller refuses. An IPv4-mapped IPv6 address is returned as the IPv4 it carries.
 */
export function boundSourceIp(headers: Readonly<Record<string, string | undefined>>): string | undefined {
  const raw = headers[BOUND_SOURCE_IP_HEADER]?.trim();
  if (!raw || raw.includes(",") || raw.includes("%")) return undefined;
  const bare = raw.toLowerCase().startsWith("::ffff:") && isIP(raw.slice(7)) === 4 ? raw.slice(7) : raw;
  return isIP(bare) === 0 ? undefined : bare;
}
