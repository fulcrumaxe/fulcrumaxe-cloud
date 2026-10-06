import { createHash, randomInt } from "node:crypto";
import { CredentialMode } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";

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
 * registrant are the session's, never the body's. The row is written with the platform_ops login (app_user has no INSERT
 * on the table), and only after the role was read under the caller's own tenant context.
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

  await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
    const { rows } = await client.query<{ role: string | null }>("SELECT current_member_role() AS role");
    if (rows[0]?.role !== "owner" && rows[0]?.role !== "admin") throw new RunnerHttpError(403, "forbidden", "only an owner or admin can create a registration code");
    if (repoIds.length > 0) {
      const known = await client.query("SELECT 1 FROM repos WHERE id = ANY($1::uuid[])", [repoIds]);
      if (known.rowCount !== repoIds.length) throw new RunnerHttpError(400, "unknown_repo", "a repo is not one of this account's");
    }
  });

  const code = newRegistrationCode();
  const { rows } = await deps.platformOpsPool.query<{ expires_at: Date }>(
    `INSERT INTO runner_registration_codes (account_id, registered_by, code_sha256, expires_at, credential_mode, allowed_repo_ids)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4), $5, $6::uuid[]) RETURNING expires_at`,
    [principal.accountId, principal.userId, hashRegistrationCode(code), CODE_TTL_MINUTES, mode.data, repoIds],
  );
  return { status: 201, body: { code, expires_at: rows[0]!.expires_at.toISOString() }, headers: { "cache-control": "no-store" } };
}
