/**
 * The job-signing public keys this build trusts, one set per cloud address (D#6 R4a-2b, correction C26 section 2 item 1).
 *
 * They are committed here, in the build. Nothing read at run time (no file, environment variable or flag) can add or replace one:
 * `keyringFor` consults this constant and nothing else, and this module names no environment. Only public halves belong here
 * (an Ed25519 JWK with `kty`, `crv` and `x`); the matching private key lives only in the cloud worker's settings.
 *
 * The table is keyed by the SHA-256 (lowercase hex) of the address as `new URL(address).origin` writes it, never by the address
 * text, so that a private host name never appears in public code. An address with no entry has no keyring, and `fx-runner run`
 * refuses it before its first claim (`job_keyring_missing`). The production address has no entry until its key pair exists (an
 * owner action). Add an address as `"<hash>": { "<key_id>": { kty: "OKP", crv: "Ed25519", x: "<43 characters>" } }`.
 */
import { createHash } from "node:crypto";
import type { JobKeyring } from "@fulcrumaxe/runner-protocol";

export type PinnedKeyrings = Readonly<Record<string, JobKeyring>>;

export const PINNED_JOB_KEYS: PinnedKeyrings = Object.freeze({
  // staging (private host; hash only)
  c99106f0f3e8720c0d2d5f275f8d341a21367d193ffbb416e7a73a9ebb00fe0f: Object.freeze({
    "staging-2026-10": Object.freeze({ kty: "OKP", crv: "Ed25519", x: "FJkPp3H78wE-VIwcXU1bOt7XZDswNqr13ogaq-8tzdo" } as const),
  }),
});

/** The table key for an address: the SHA-256 of its normalised origin, or undefined when it is not an address. */
export function originHash(address: string): string | undefined {
  let origin: string;
  try {
    origin = new URL(address).origin;
  } catch {
    // fx-swallow-ok: a string that is not an address has no keyring
    return undefined;
  }
  return createHash("sha256").update(origin, "utf8").digest("hex");
}

/** The pinned keys for `address`, or undefined when this build pins none. */
export function keyringFor(address: string, table: PinnedKeyrings = PINNED_JOB_KEYS): JobKeyring | undefined {
  const hash = originHash(address);
  const entry = hash !== undefined && Object.hasOwn(table, hash) ? table[hash] : undefined;
  return entry !== undefined && Object.keys(entry).length > 0 ? entry : undefined;
}
