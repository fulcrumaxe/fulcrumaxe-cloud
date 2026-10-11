import { createHash, randomInt } from "node:crypto";
import { CredentialMode } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { UNNAMED_MEMBER } from "./memberRole.js";
import { RunnerHttpError, pgCode, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";

/** A provisioning token lives an hour unless the request asks for less or more (D#605 FL-6). */
export const PROVISIONING_TOKEN_DEFAULT_TTL_SECONDS = 60 * 60;
/** The longest a token may live: a day. The database refuses longer too. */
export const PROVISIONING_TOKEN_MAX_TTL_SECONDS = 24 * 60 * 60;
/** The shortest: a minute, so a lifetime of 0 or a negative one is a mistake, not a token that is dead at birth. */
const MIN_TTL_SECONDS = 60;
/** Most unused, unexpired tokens one account may hold at a time. The database counts them under a lock. */
export const MAX_OUTSTANDING_PROVISIONING_TOKENS = 5;
const MAX_REPOS = 100;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The form of every provisioning token; the register route picks this kind of credential by the prefix alone. */
export const PROVISIONING_TOKEN_PREFIX = "fxrp_";

export const hashProvisioningToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

/** `fxrp_` and 40 characters drawn uniformly from 62, about 238 bits. Only the SHA-256 of it is ever stored. */
export function newProvisioningToken(): string {
  let text = "";
  for (let i = 0; i < 40; i++) text += ALPHABET[randomInt(ALPHABET.length)];
  return `${PROVISIONING_TOKEN_PREFIX}${text}`;
}

const NO_STORE = { "cache-control": "no-store" } as const;
const bad = (): RunnerHttpError => new RunnerHttpError(400, "invalid_message", "the body does not match");

/**
 * POST /api/runners/provisioning-tokens (a session route). An owner or admin mints a token: the account and the minter are the session's, never the
 * body's. `runner_provisioning_token_mint` (0786) checks the role, the repos, the lifetime and the five-outstanding limit in one transaction. The secret
 * is in this one reply and nowhere else: not stored, not logged, not in a URL.
 */
export async function mintProvisioningToken(deps: RunnerCloudDeps, principal: SessionPrincipal, input: unknown): Promise<RunnerHttpResponse> {
  const body = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
  const allowed = new Set(["credential_mode", "allowed_repo_ids", "labels", "name", "ttl_seconds"]);
  if (!body || Object.keys(body).some((k) => !allowed.has(k))) throw bad();
  const mode = CredentialMode.safeParse(body.credential_mode);
  const repos = body.allowed_repo_ids ?? [];
  const labels = body.labels ?? [];
  const ttl = "ttl_seconds" in body ? body.ttl_seconds : PROVISIONING_TOKEN_DEFAULT_TTL_SECONDS;
  const name = body.name ?? null;
  if (!mode.success || !Array.isArray(repos) || repos.length > MAX_REPOS || !repos.every((r) => typeof r === "string" && UUID.test(r))) throw bad();
  if (!Array.isArray(labels) || labels.length > 16 || !labels.every((l) => typeof l === "string" && l.length <= 32)) throw bad();
  if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < MIN_TTL_SECONDS || ttl > PROVISIONING_TOKEN_MAX_TTL_SECONDS) throw bad();
  if (name !== null && (typeof name !== "string" || name.length > 64)) throw bad();
  const repoIds = [...new Set((repos as string[]).map((r) => r.toLowerCase()))];

  const token = newProvisioningToken();
  try {
    const row = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
      const { rows } = await client.query<{ token_id: string; expires_at: Date }>("SELECT * FROM runner_provisioning_token_mint($1, $2, $3, $4::uuid[], $5::text[], $6)", [
        hashProvisioningToken(token),
        name,
        mode.data,
        repoIds,
        labels as string[],
        ttl,
      ]);
      return rows[0]!;
    });
    return { status: 201, body: { id: row.token_id, token, expires_at: row.expires_at.toISOString(), name }, headers: NO_STORE };
  } catch (error) {
    throw mapMintError(error);
  }
}

function mapMintError(error: unknown): unknown {
  switch (pgCode(error)) {
    case "42501":
      return new RunnerHttpError(403, "forbidden", "only an owner or admin can manage provisioning tokens");
    case "P0002":
      return new RunnerHttpError(400, "unknown_repo", "a repo is not one of this account's");
    case "53400":
      return new RunnerHttpError(409, "token_limit", `this account already has ${MAX_OUTSTANDING_PROVISIONING_TOKENS} unused provisioning tokens`);
    case "22023":
      return bad();
    default:
      return error;
  }
}

export interface ProvisioningTokenEntry {
  id: string;
  name: string | null;
  labels: string[];
  credential_mode: "subscription" | "api_key";
  allowed_repo_ids: string[];
  minted_by: { id: string; name: string };
  created_at: string;
  expires_at: string;
}

/** What a minter with no name shows as, so no line reads null. */
const UNNAMED_MINTER = UNNAMED_MEMBER;

/** GET /api/runners/provisioning-tokens (a session route, owner or admin): the unused, unexpired tokens whose minter is still an owner or admin. Never the secret or its hash. */
export async function listProvisioningTokens(deps: RunnerCloudDeps, principal: SessionPrincipal): Promise<RunnerHttpResponse> {
  try {
    const tokens = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client): Promise<ProvisioningTokenEntry[]> => {
      const { rows } = await client.query<{
        id: string;
        created_by: string;
        name: string | null;
        labels: string[];
        credential_mode: "subscription" | "api_key";
        allowed_repo_ids: string[];
        created_at: Date;
        expires_at: Date;
      }>("SELECT * FROM runner_provisioning_token_list()");
      const ids = [...new Set(rows.map((r) => r.created_by))];
      const names = new Map<string, string>();
      if (ids.length > 0) {
        const found = await client.query<{ id: string; label: string }>("SELECT id, COALESCE(NULLIF(name, ''), NULLIF(github_login, ''), $2) AS label FROM users WHERE id = ANY($1::uuid[])", [ids, UNNAMED_MINTER]);
        for (const f of found.rows) names.set(f.id, f.label);
      }
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        labels: r.labels,
        credential_mode: r.credential_mode,
        allowed_repo_ids: r.allowed_repo_ids,
        minted_by: { id: r.created_by, name: names.get(r.created_by) ?? UNNAMED_MINTER },
        created_at: r.created_at.toISOString(),
        expires_at: r.expires_at.toISOString(),
      }));
    });
    return { status: 200, body: { tokens, limit: MAX_OUTSTANDING_PROVISIONING_TOKENS }, headers: NO_STORE };
  } catch (error) {
    throw mapMintError(error);
  }
}

/** DELETE /api/runners/provisioning-tokens/:id (a session route, owner or admin): an unused token stops working at once. A used, revoked or unknown one is 404. */
export async function revokeProvisioningToken(deps: RunnerCloudDeps, principal: SessionPrincipal, tokenId: string): Promise<RunnerHttpResponse> {
  if (!UUID.test(tokenId)) throw new RunnerHttpError(404, "not_found", "no such unused provisioning token");
  try {
    const revoked = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
      const { rows } = await client.query<{ revoked: boolean }>("SELECT runner_provisioning_token_revoke($1::uuid) AS revoked", [tokenId.toLowerCase()]);
      return rows[0]?.revoked === true;
    });
    if (!revoked) throw new RunnerHttpError(404, "not_found", "no such unused provisioning token");
    return { status: 200, body: { id: tokenId.toLowerCase(), revoked: true }, headers: NO_STORE };
  } catch (error) {
    throw mapMintError(error);
  }
}
