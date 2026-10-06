import { createHash, randomInt } from "node:crypto";
import { CredentialMode } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, pgCode, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";

/** Registration codes live 10 minutes and work once (criterion 1). */
export const CODE_TTL_MINUTES = 10;
/** Most repos one code may name. */
const MAX_REPOS = 100;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const hashRegistrationCode = (code: string): string => createHash("sha256").update(code, "utf8").digest("hex");

/** `fxrr_` and 40 characters drawn uniformly from 62, about 238 bits. Only the SHA-256 of it is ever stored. */
export function newRegistrationCode(): string {
  let text = "";
  for (let i = 0; i < 40; i++) text += ALPHABET[randomInt(ALPHABET.length)];
  return `fxrr_${text}`;
}

/**
 * POST /api/runners/registration-codes (a session route). Only an owner or admin may mint a code; the account and the
 * registrant are the session's, never the body's. The row is written by `runner_registration_code_create` (0724), which
 * checks the caller's role and the repos itself; app_user has no INSERT on the table.
 */
export async function mintRegistrationCode(deps: RunnerCloudDeps, principal: SessionPrincipal, input: unknown): Promise<RunnerHttpResponse> {
  const body = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
  if (!body || Object.keys(body).some((k) => k !== "credential_mode" && k !== "allowed_repo_ids")) {
    throw new RunnerHttpError(400, "invalid_message", "the body does not match");
  }
  const mode = CredentialMode.safeParse(body.credential_mode);
  const repos = body.allowed_repo_ids ?? [];
  if (!mode.success || !Array.isArray(repos) || repos.length > MAX_REPOS || !repos.every((r) => typeof r === "string" && UUID.test(r))) {
    throw new RunnerHttpError(400, "invalid_message", "the body does not match");
  }
  const repoIds = [...new Set((repos as string[]).map((r) => r.toLowerCase()))];

  // One definer (0724) checks the role (owner or admin, from the session), the repos and the insert in one transaction.
  const code = newRegistrationCode();
  let expiresAt: Date;
  try {
    expiresAt = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
      const { rows } = await client.query<{ expires_at: Date }>("SELECT runner_registration_code_create($1, $2, $3::uuid[], $4) AS expires_at", [
        hashRegistrationCode(code),
        mode.data,
        repoIds,
        CODE_TTL_MINUTES,
      ]);
      return rows[0]!.expires_at;
    });
  } catch (error) {
    switch (pgCode(error)) {
      case "42501":
        throw new RunnerHttpError(403, "forbidden", "only an owner or admin can create a registration code");
      case "P0002":
        throw new RunnerHttpError(400, "unknown_repo", "a repo is not one of this account's");
      case "22023":
        throw new RunnerHttpError(400, "invalid_message", "the body does not match");
      default:
        throw error;
    }
  }
  return { status: 201, body: { code, expires_at: expiresAt.toISOString() }, headers: { "cache-control": "no-store" } };
}
