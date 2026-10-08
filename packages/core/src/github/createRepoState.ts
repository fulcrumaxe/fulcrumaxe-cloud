import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NewRepoVisibility } from "./repoName.js";

/**
 * D#2 RC-1a/RC-1b: the signed state of the repo-creation flow. It lives in
 * @fx/core so the API route (which mints it) and @fx/github (which verifies it
 * at the callback) share one implementation without a new package edge.
 */
export const CREATE_STATE_TTL_SECONDS = 10 * 60;
export const CREATE_LIMIT_PER_HOUR = 10;
export const CREATE_LIMIT_PER_DAY = 50;

export interface CreateRepoClaims {
  account_id: string;
  user_id: string;
  owner_gh_id: number;
  name: string;
  visibility: NewRepoVisibility;
  /** sha256 hex of the trimmed description (empty string when none). */
  description_sha256: string;
  /** The trimmed description itself: the callback is a GET, so it rides in the signed state. */
  description?: string;
  auto_init: boolean;
  nonce: string;
  exp: number;
}

export const descriptionHash = (description: string | null): string => createHash("sha256").update(description ?? "").digest("hex");

/** Domain-separated from the install state, so one can never be presented as the other. */
const mac = (payload: string, secret: string): Buffer => createHmac("sha256", secret).update(`create-repo.${payload}`).digest();

export function mintCreateRepoState(input: Omit<CreateRepoClaims, "nonce" | "exp">, secret: string, now: Date = new Date()): string {
  const claims: CreateRepoClaims = {
    ...input,
    nonce: randomBytes(16).toString("base64url"),
    exp: Math.floor(now.getTime() / 1000) + CREATE_STATE_TTL_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${mac(payload, secret).toString("base64url")}`;
}

export function verifyCreateRepoState(state: string, secret: string, now: Date = new Date()): CreateRepoClaims | null {
  const parts = state.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]+$/.test(parts[1]!)) return null;
  const given = Buffer.from(parts[1]!, "base64url");
  const expected = mac(parts[0]!, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const c = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const ok =
      typeof c.account_id === "string" && typeof c.user_id === "string" && typeof c.name === "string" &&
      typeof c.owner_gh_id === "number" && Number.isSafeInteger(c.owner_gh_id) && c.owner_gh_id > 0 &&
      (c.visibility === "private" || c.visibility === "public") && typeof c.description_sha256 === "string" &&
      (c.description === undefined || typeof c.description === "string") &&
      typeof c.auto_init === "boolean" && typeof c.nonce === "string" && typeof c.exp === "number" &&
      c.exp > Math.floor(now.getTime() / 1000);
    return ok ? (c as unknown as CreateRepoClaims) : null;
  } catch {
    // fx-swallow-ok: a state token that does not decode or verify is rejected as null; the caller treats it as invalid input
    return null;
  }
}
