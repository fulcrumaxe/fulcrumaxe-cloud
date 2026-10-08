import { createHmac } from "node:crypto";

/**
 * D#37 WS-C, Resolved disagreement 7: "Storage isolation (architect:
 * prefix with a hash of the account id; security: HMAC namespace plus
 * wipe). Security's rule adopted." The hazard this closes (D#37
 * technical-architect finding): "global localStorage keys ... let a
 * second account in the same browser inherit the first account's open
 * -window layout." Namespacing by ACCOUNT (not user) is deliberate --
 * layout preferences are a property of the workspace a browser is
 * currently signed into, and every fork storage key is `fx:<storage_ns>:
 * <name>` (criterion 11); switching accounts in the same browser must
 * land on a different namespace even for the same human user.
 *
 * An HMAC, not a plain hash: a plain hash of a (small, enumerable) UUID
 * account id would let anyone precompute the mapping id -> namespace and
 * correlate a leaked namespace back to a specific account id. Keying on
 * a server secret (never shipped to the client) makes that correlation
 * infeasible without the secret.
 */
/**
 * H7b: the key behind the storage namespace and the opaque user id is its own
 * setting, FX_STABLE_ID_SECRET, so rotating the session secret changes
 * neither (a rotation must not read as a different user, or the signed-out
 * dialog would wipe a returning user's state). Unset or blank, it falls back
 * to FX_SESSION_SECRET so today's namespaces and ids keep working; that is
 * logged once per process, and /api/health reports the setting missing.
 * Set but shorter than 32 characters it throws rather than falling back: a
 * quiet fallback would change every namespace and id.
 */
let fallbackLogged = false;

function hmacSecret(env: NodeJS.ProcessEnv): string {
  const stable = env.FX_STABLE_ID_SECRET;
  if (stable !== undefined && stable.trim() !== "") {
    if (stable.length < 32) {
      throw new Error("FX_STABLE_ID_SECRET must be a string of at least 32 characters");
    }
    return stable;
  }
  const secret = env.FX_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("FX_SESSION_SECRET must be set to a string of at least 32 characters");
  }
  if (!fallbackLogged) {
    fallbackLogged = true;
    console.warn("FX_STABLE_ID_SECRET is not set; the storage namespace and opaque user id are derived from FX_SESSION_SECRET, so rotating it would change both");
  }
  return secret;
}

/** base64url, no padding -- safe to embed in a `fx:<storage_ns>:<name>` localStorage key and in JSON without escaping. */
function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The `storage_ns` field D#37 WS-C criterion 3's `/api/cloud/auth/me` and `/api/profile` responses carry. Deterministic per account (so a returning sign-in reuses the same namespace, preserving layout), but not derivable from the account id without the server secret. */
export function storageNamespace(accountId: string, env: NodeJS.ProcessEnv = process.env): string {
  const mac = createHmac("sha256", hmacSecret(env)).update(`storage_ns:${accountId}`).digest();
  return base64url(mac.subarray(0, 16));
}

/**
 * D#37 WS-C criterion 3: "an opaque `id` (never a DB id and never `1`)."
 * `1` is the jpos single-local-user hazard the security-expert named
 * directly (`/api/profile` returning `id:1, isAdmin:true`) -- this
 * value is astronomically unlikely to collide with the literal string
 * "1", and is never the raw `users.id` UUID a caller could otherwise
 * enumerate or correlate across accounts.
 */
export function opaqueUserId(userId: string, env: NodeJS.ProcessEnv = process.env): string {
  const mac = createHmac("sha256", hmacSecret(env)).update(`opaque_user_id:${userId}`).digest();
  return base64url(mac.subarray(0, 16));
}
