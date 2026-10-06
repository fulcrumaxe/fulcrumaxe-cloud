import { CREATE_LIMIT_PER_DAY, CREATE_LIMIT_PER_HOUR, descriptionHash, verifyCreateRepoState, type CreateRepoClaims } from "@fx/core/src/github/createRepoState.js";
import { withPlatformOps } from "@fx/core/src/tenancy/withPlatformOps.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { GH_OWNER_LOGIN_RE } from "./eventMapper.js";
import { validateNewRepo } from "./repoName.js";
import { syncInstallationRepos, type SyncDeps } from "./syncInstallationRepos.js";
import { OAUTH_ENV_NAMES } from "./userInstallations.js";

/**
 * D#2 RC-1a (C61 sections 1-4, as amended by C64): creates a repository for
 * the customer with the customer's OWN GitHub App user token, exchanged from
 * the callback's one-time `code`, used in this file only and never returned,
 * stored or logged. Installation tokens never create repos, and the
 * add-to-installation endpoint (a classic-PAT-only call) is never made.
 *
 * After a 201 the repo is connected only if GitHub's installation now includes
 * it: `syncInstallationRepos` runs once (the single `repos` writer) and a
 * `repos` row for the new id decides `ok` vs `created_not_connected`. The
 * later `installation_repositories` delivery connects it whenever the
 * customer adds it. A created repo is never deleted.
 *
 * GitHub's words never reach the caller: answers map to a fixed outcome, and
 * the returned URLs are built from validated login, our recorded installation
 * id and our validated name.
 */
export type CreateRepoOutcome =
  | "ok"
  | "created_not_connected"
  | "name_taken"
  | "visibility_not_allowed"
  | "refused"
  | "github_busy"
  | "rate_limited"
  | "install_first"
  | "failed";

export interface CreateRepoResult {
  outcome: CreateRepoOutcome;
  /** `ok` and `created_not_connected` only. */
  repoUrl?: string;
  /** `created_not_connected` only: the installation's settings page on GitHub. */
  installationUrl?: string;
}

export interface CreateRepoDeps extends SyncDeps {
  env: Record<string, string | undefined>;
  now?: () => Date;
}

export { CREATE_LIMIT_PER_DAY, CREATE_LIMIT_PER_HOUR, CREATE_STATE_TTL_SECONDS, descriptionHash, mintCreateRepoState, verifyCreateRepoState } from "@fx/core/src/github/createRepoState.js";
export type { CreateRepoClaims } from "@fx/core/src/github/createRepoState.js";

const TIMEOUT_MS = 10_000;
const MAX_PAGES = 10;
const PER_PAGE = 100;
const headers = (token: string) => ({ accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" });

interface Recorded {
  id: string;
  ghInstallationId: number;
}

/** Everything that needs our database before any GitHub call: replay, role, account state, rate, recorded installations, and the reservation itself. */
async function gate(deps: CreateRepoDeps, accountId: string, userId: string, nonce: string): Promise<"uncounted" | "rate_limited" | Recorded[]> {
  return withPlatformOps(deps.platformOpsPool, async (client) => {
    await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
    // One creation gate per account at a time: the count and the reservation below commit together. Released at COMMIT, before any GitHub call.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`repo_create:${accountId}`]);
    const counts = await client.query<{ last_hour: string; last_day: string; nonce_seen: boolean }>(
      "SELECT last_hour, last_day, nonce_seen FROM github_repo_create_audit_counts($1, $2)",
      [accountId, nonce],
    );
    // A replay, a non-admin or an inactive account is refused without a refused row: it makes no GitHub call, and counting it would let a member burn the owners' quota.
    if (counts.rows[0]?.nonce_seen) return "uncounted";
    const member = await client.query<{ role: string }>("SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2", [accountId, userId]);
    const acct = await client.query<{ status: string }>("SELECT status FROM accounts WHERE id = $1 AND deleted_at IS NULL", [accountId]);
    const role = member.rows[0]?.role;
    if ((role !== "owner" && role !== "admin") || acct.rows[0]?.status !== "active") return "uncounted";
    if (Number(counts.rows[0]?.last_hour) >= CREATE_LIMIT_PER_HOUR || Number(counts.rows[0]?.last_day) >= CREATE_LIMIT_PER_DAY) return "rate_limited";
    const inst = await client.query<{ id: string; gh_installation_id: string }>(
      `SELECT i.id, i.gh_installation_id FROM installations i
         JOIN installation_installers n ON n.gh_installation_id = i.gh_installation_id AND n.app_kind = i.app_kind
        WHERE i.account_id = $1 AND i.app_kind = 'team' AND n.deleted_at IS NULL AND n.suspended_at IS NULL ORDER BY i.id`,
      [accountId],
    );
    if (inst.rows.length === 0) return [];
    // The reservation spends a slot from here on, whatever GitHub later answers.
    await client.query("SELECT audit_write_system($1, 'github_install', 'github.repo_create_reserved', $2::jsonb)", [accountId, JSON.stringify({ nonce, by: userId })]);
    return inst.rows.map((r) => ({ id: r.id, ghInstallationId: Number(r.gh_installation_id) }));
  });
}

/** Throws when the write fails: the caller decides whether that fails closed. */
const audit = (deps: CreateRepoDeps, accountId: string, action: string, payload: Record<string, unknown>) =>
  withPlatformOps(deps.platformOpsPool, (client) =>
    client.query("SELECT audit_write_system($1, 'github_install', $2, $3::jsonb)", [accountId, action, JSON.stringify(payload)]),
  );

/** Maps GitHub's create answer to a fixed outcome. Only the classification reads the body. */
async function mapFailure(res: Response): Promise<CreateRepoOutcome> {
  if (res.status === 429) return "github_busy";
  const text = await res.text().catch(() => "");
  if (res.status === 403) return /rate limit|abuse/i.test(text) || res.headers.get("retry-after") ? "github_busy" : "refused";
  if (res.status === 404) return "refused";
  if (res.status === 422) return /name already exists/i.test(text) ? "name_taken" : /visibility/i.test(text) ? "visibility_not_allowed" : "failed";
  return "failed";
}

export interface CreateRepoInput {
  accountId: string;
  userId: string;
  /** The callback's one-time OAuth code. */
  code: string;
  state: string;
  /** Optional plain text; when the signed state carries no description of its own this is the one used, and its hash must match the state's. */
  description?: string | null;
}

/** `uncounted`: refused before any GitHub call for a reason that must not spend the account's quota. */
type Attempted = CreateRepoResult & { uncounted?: true };

async function attempt(deps: CreateRepoDeps, input: CreateRepoInput, claims: CreateRepoClaims, description: string | null): Promise<Attempted> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const gated = await gate(deps, input.accountId, input.userId, claims.nonce);
  if (gated === "uncounted") return { outcome: "failed", uncounted: true };
  if (gated === "rate_limited") return { outcome: gated };
  if (gated.length === 0) return { outcome: "install_first" };

  const names = OAUTH_ENV_NAMES.team;
  const clientId = deps.env[names.clientId];
  const clientSecret = deps.env[names.clientSecret];
  if (!clientId || !clientSecret) return { outcome: "failed" };
  const exchange = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code: input.code }),
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const token = exchange.ok ? ((await exchange.json()) as { access_token?: unknown } | null)?.access_token : undefined;
  // Token-kind guard: only a user-to-server token (`ghu_`) may create a repo; anything else stops here.
  if (typeof token !== "string" || !token.startsWith("ghu_")) return { outcome: "failed" };

  const get = (url: string) => fetchImpl(url, { headers: headers(token), redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const me = await get("https://api.github.com/user");
  const meId = me.ok ? ((await me.json()) as { id?: unknown } | null)?.id : undefined;

  // The owner must be among the user's own team-App installations, and the chosen one must be recorded for this account.
  const appId = deps.appCredentials("team").appId;
  type Entry = { id?: unknown; app_id?: unknown; account?: { id?: unknown; login?: unknown; type?: unknown } };
  const forOwner: Entry[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await get(`https://api.github.com/user/installations?per_page=${PER_PAGE}&page=${page}`);
    const list = res.ok ? ((await res.json()) as { installations?: Entry[] } | null)?.installations : undefined;
    if (!Array.isArray(list)) return { outcome: "failed" };
    forOwner.push(...list.filter((e) => String(e.app_id) === appId && e.account?.id === claims.owner_gh_id));
    if (list.length < PER_PAGE) break;
  }
  if (forOwner.length === 0) return { outcome: "install_first" };
  const hit = forOwner.map((e) => ({ e, rec: gated.find((r) => r.ghInstallationId === e.id) })).find((x) => x.rec);
  const rec = hit?.rec;
  const login = hit?.e.account?.login;
  const type = hit?.e.account?.type;
  if (!rec || typeof login !== "string" || !GH_OWNER_LOGIN_RE.test(login)) return { outcome: "failed" };
  if (type === "User" ? typeof meId !== "number" || meId !== claims.owner_gh_id : type !== "Organization") return { outcome: "failed" };

  const created = await fetchImpl(type === "User" ? "https://api.github.com/user/repos" : `https://api.github.com/orgs/${login}/repos`, {
    method: "POST",
    headers: { ...headers(token), "content-type": "application/json" },
    body: JSON.stringify({ name: claims.name, private: claims.visibility !== "public", auto_init: claims.auto_init, ...(description ? { description } : {}) }),
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (created.status !== 201) return { outcome: await mapFailure(created) };
  const ghRepoId = ((await created.json().catch(() => null)) as { id?: unknown } | null)?.id;
  const repoUrl = `https://github.com/${login}/${claims.name}`;

  let connected = false;
  if (typeof ghRepoId === "number" && Number.isSafeInteger(ghRepoId) && ghRepoId > 0) {
    try {
      await syncInstallationRepos(deps, rec.id);
      connected = await withTenant(deps.appUserPool, input.accountId, async (client) =>
        (await client.query("SELECT 1 FROM repos WHERE account_id = $1 AND gh_repo_id = $2 AND installation_id = $3", [input.accountId, ghRepoId, rec.id])).rowCount === 1,
      );
    } catch {
      connected = false;
    }
  }
  // Fails closed: if this row cannot be written the attempt is not reported as done (the repo is never deleted).
  await audit(deps, input.accountId, "github.repo_created", {
    gh_owner_id: claims.owner_gh_id, gh_repo_id: ghRepoId ?? null, name: claims.name, visibility: claims.visibility, connected, by: input.userId, nonce: claims.nonce,
  });
  if (connected) return { outcome: "ok", repoUrl };
  const installationUrl =
    type === "User"
      ? `https://github.com/settings/installations/${rec.ghInstallationId}`
      : `https://github.com/organizations/${login}/settings/installations/${rec.ghInstallationId}`;
  return { outcome: "created_not_connected", repoUrl, installationUrl };
}

export async function createCustomerRepo(deps: CreateRepoDeps, input: CreateRepoInput): Promise<CreateRepoResult> {
  const secret = deps.env.GITHUB_INSTALL_STATE_SECRET;
  const claims = secret ? verifyCreateRepoState(input.state, secret, (deps.now ?? (() => new Date()))()) : null;
  if (!claims || claims.account_id !== input.accountId || claims.user_id !== input.userId) return { outcome: "failed" };
  const valid = validateNewRepo({ name: claims.name, visibility: claims.visibility, description: claims.description ?? input.description, autoInit: claims.auto_init });
  if (!valid.ok || descriptionHash(valid.value.description) !== claims.description_sha256) return { outcome: "failed" };

  let result: Attempted;
  try {
    result = await attempt(deps, input, claims, valid.value.description);
  } catch {
    result = { outcome: "failed" };
  }
  const { uncounted, ...publicResult } = result;
  if (!uncounted && result.outcome !== "ok" && result.outcome !== "created_not_connected" && result.outcome !== "rate_limited") {
    await audit(deps, input.accountId, "github.repo_create_refused", { outcome: result.outcome }).catch(() => undefined);
  }
  return publicResult;
}
