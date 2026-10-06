import type { Pool } from "pg";
import { withPlatformOps } from "@fx/core/src/tenancy/withPlatformOps.js";
import { emitDomainEvent } from "@fx/core/src/domain-events/emit.js";
import { materializeRoleDefaults } from "@fx/core/src/role-settings/materialize.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import type { AppCredentialsSource } from "./appCredentials.js";
import { GH_OWNER_LOGIN_RE, GH_REPO_NAME_RE } from "./eventMapper.js";
import { getInstallationToken, type AccessTokenRequester, type InstallationTokenCache } from "./installationToken.js";
import { atStage, syncFailureTag } from "./syncFailureTag.js";

/**
 * D#2 H17b-1 (C51 H17b, C62): repo sync for a claimed installation. Lists the
 * installation's repositories with that kind's installation token and upserts
 * one `repos` row per repository, as the tenant's `app_user` through the
 * session-less `withTenant` (no migration, no `platform_ops` grant).
 *
 * The tenant comes only from our own `installations` row, read by its id: never
 * from a request, state or payload. Unclaimed (no row, no recorded installer),
 * deleted or suspended installations are skipped and write nothing. Every
 * write is bound to that one installation.
 *
 * `repos` has no unique key, so each repository is select-then-insert-or-update
 * under `pg_advisory_xact_lock` on (account, GitHub repo id, product), in one
 * transaction. Locks are taken in ascending repo-id order so two syncs cannot
 * deadlock. Each NEW repos row also gets one role_settings row per manifest role, in
 * that same transaction (mode = the manifest defaultMode at that moment). A `team` install re-points a `team_readonly` row; never the reverse.
 * Repos of this installation that GitHub no longer lists are detached (installation_id
 * set NULL, never deleted), but only after a complete listing.
 * Nothing here logs a token or a repository name.
 */
export interface SyncDeps {
  platformOpsPool: Pool;
  appUserPool: Pool;
  appCredentials: AppCredentialsSource;
  requester: AccessTokenRequester;
  cache: InstallationTokenCache;
  fetchImpl?: typeof fetch;
  /** Fixed-text notices only; defaults to console.warn. */
  warn?: (message: string) => void;
}

export type SyncResult =
  | { status: "synced"; inserted: number; updated: number; repointed: number; detached: number; skippedInvalid: number }
  | { status: "skipped"; reason: "unclaimed" | "inactive" | "unsupported_kind" };

const PER_PAGE = 100;
const MAX_PAGES = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Listed {
  ghRepoId: number;
  owner: string;
  name: string;
}

/** Paged `GET /installation/repositories`. Entries failing the id/name/owner grammar are counted, not returned. */
async function listRepositories(
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ repos: Listed[]; skippedInvalid: number; listedIds: number[]; complete: boolean }> {
  const byId = new Map<number, Listed>();
  // Every id GitHub listed, including entries whose name fails our grammar: those are still
  // part of the installation and must not be detached.
  const listedIds = new Set<number>();
  let skippedInvalid = 0;
  let sawLastPage = false;
  let unusableId = false;
  // A page that is not a `repositories` array (an empty object, null, a message object) is not a
  // listing at all, so it must never read as an empty one.
  let malformedPage = false;
  let totalCount: unknown;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetchImpl(`https://api.github.com/installation/repositories?per_page=${PER_PAGE}&page=${page}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 200) throw new Error(`syncInstallationRepos: list_failed (${res.status})`);
    const body = (await res.json()) as { total_count?: unknown; repositories?: Array<{ id?: unknown; name?: unknown; owner?: { login?: unknown } }> } | null;
    if (!Array.isArray(body?.repositories)) {
      malformedPage = true;
      break;
    }
    const items = body.repositories;
    totalCount = body.total_count;
    for (const r of items) {
      const owner = r?.owner?.login;
      if (typeof r?.id === "number" && Number.isSafeInteger(r.id) && r.id > 0) listedIds.add(r.id);
      else unusableId = true;
      if (
        typeof r?.id === "number" && Number.isSafeInteger(r.id) && r.id > 0 &&
        typeof r.name === "string" && GH_REPO_NAME_RE.test(r.name) &&
        typeof owner === "string" && GH_OWNER_LOGIN_RE.test(owner)
      ) {
        byId.set(r.id, { ghRepoId: r.id, owner, name: r.name });
      } else {
        skippedInvalid++;
      }
    }
    if (items.length < PER_PAGE) {
      sawLastPage = true;
      break;
    }
  }
  // Only a listing read to its last page, made of well-formed pages, with every entry carrying a usable id
  // and (when GitHub states one) as many distinct ids as its total_count, may be used to detach.
  const countAgrees = totalCount === undefined || (typeof totalCount === "number" && totalCount === listedIds.size);
  return {
    repos: [...byId.values()].sort((a, b) => a.ghRepoId - b.ghRepoId),
    skippedInvalid,
    listedIds: [...listedIds],
    complete: sawLastPage && !unusableId && !malformedPage && countAgrees,
  };
}

export async function syncInstallationRepos(deps: SyncDeps, installationId: string): Promise<SyncResult> {
  if (!UUID_RE.test(installationId)) return { status: "skipped", reason: "unclaimed" };

  // Tenant and kind come from our own row; the claim state from the installer record.
  const gate = await atStage("read_installation", withPlatformOps(deps.platformOpsPool, async (client) => {
    const inst = await client.query<{ account_id: string; gh_installation_id: string; app_kind: string }>(
      "SELECT account_id, gh_installation_id, app_kind FROM installations WHERE id = $1",
      [installationId],
    );
    const row = inst.rows[0];
    if (!row) return null;
    const rec = await client.query<{ deleted_at: Date | null; suspended_at: Date | null }>(
      "SELECT deleted_at, suspended_at FROM installation_installers WHERE gh_installation_id = $1 AND app_kind = $2",
      [row.gh_installation_id, row.app_kind],
    );
    return { row, rec: rec.rows[0] };
  }));
  if (!gate?.rec) return { status: "skipped", reason: "unclaimed" };
  if (gate.rec.deleted_at || gate.rec.suspended_at) return { status: "skipped", reason: "inactive" };

  const { account_id: accountId, app_kind: kind } = gate.row;
  const ghInstallationId = Number(gate.row.gh_installation_id);
  if (kind !== "team" && kind !== "team_readonly" && kind !== "sitekit") return { status: "skipped", reason: "unsupported_kind" };
  // Site-kit rows sit beside team rows: the product (and so the lock key and every lookup) is per kind.
  const product = kind === "sitekit" ? "sitekit" : "team";

  // An installation-wide, metadata-read token (the explicit WideScope variant).
  const token = await atStage("mint_token", getInstallationToken({
    installationId: ghInstallationId,
    appKind: kind,
    purpose: kind === "team" ? "run" : kind === "sitekit" ? "sitekit_read" : "preview_read",
    role: "repo_sync",
    scope: { installationWide: true, permissions: { metadata: "read" } },
    appCredentials: deps.appCredentials,
    requester: deps.requester,
    cache: deps.cache,
  }));
  const { repos, skippedInvalid, listedIds, complete } = await atStage("list_repos", listRepositories(token, deps.fetchImpl ?? fetch));
  if (skippedInvalid > 0) (deps.warn ?? console.warn)(`syncInstallationRepos: skipped ${skippedInvalid} repositories failing the name grammar`);

  const counts = { inserted: 0, updated: 0, repointed: 0, detached: 0 };
  // H17b-2: the write phase holds the installation's advisory lock (the one the
  // lifecycle update takes first) and re-reads the installer record under it, so a
  // suspension or deletion either lands before this check (nothing is written) or waits
  // for this commit. app_user cannot read the record, hence the platform_ops transaction.
  const writeRows = () => withTenant(deps.appUserPool, accountId, async (client) => {
    // RLS pins this to the tenant; the row must still be there and be ours.
    const still = await client.query("SELECT 1 FROM installations WHERE id = $1 AND account_id = $2", [installationId, accountId]);
    if (still.rowCount === 0) return false;
    for (const r of repos) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`repos-sync:${accountId}:${r.ghRepoId}:${product}`]);
      const found = await client.query<{ id: string; installation_id: string | null; other_kind: string | null }>(
        `SELECT r.id, r.installation_id, i.app_kind AS other_kind
           FROM repos r LEFT JOIN installations i ON i.id = r.installation_id AND i.account_id = r.account_id
          WHERE r.account_id = $1 AND r.gh_repo_id = $2 AND r.product = $3
          ORDER BY r.created_at, r.id LIMIT 1 FOR UPDATE OF r`,
        [accountId, r.ghRepoId, product],
      );
      const cur = found.rows[0];
      if (!cur) {
        const created = await client.query<{ id: string }>(
          `INSERT INTO repos (account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $6, $4, $5) RETURNING id`,
          [accountId, installationId, r.ghRepoId, r.owner, r.name, product],
        );
        // A new repo gets its full role set in this same transaction: a missing role_settings row means "off".
        await materializeRoleDefaults(client, accountId, created.rows[0]!.id);
        counts.inserted++;
        continue;
      }
      const ours = cur.installation_id === installationId;
      const free = cur.installation_id === null;
      const repoint = kind === "team" && cur.other_kind === "team_readonly";
      if (!ours && !free && !repoint) continue; // another installation owns it: leave it alone
      await client.query(
        `UPDATE repos SET installation_id = $3, gh_owner = $4, gh_name = $5, updated_at = now()
          WHERE id = $1 AND account_id = $2 AND installation_id IS NOT DISTINCT FROM $6`,
        [cur.id, accountId, installationId, r.owner, r.name, cur.installation_id],
      );
      if (ours || free) counts.updated++;
      else counts.repointed++;
    }
    // Detach (never delete) this installation's repos that GitHub no longer lists. Runs in the
    // same transaction, under the same advisory lock and installer re-check as the writes above,
    // and only for a complete listing: a truncated or unreadable one must never detach anything.
    if (complete) {
      const gone = await client.query(
        `UPDATE repos SET installation_id = NULL, updated_at = now()
          WHERE account_id = $1 AND installation_id = $2 AND product = $3 AND NOT (gh_repo_id = ANY($4::bigint[]))`,
        [accountId, installationId, product, listedIds],
      );
      counts.detached = gone.rowCount ?? 0;
    }
    // A change to the repo list tells the open Repos window to re-read (same transaction as the writes).
    if (counts.inserted + counts.updated + counts.repointed + counts.detached > 0) {
      await emitDomainEvent(client, { type: "repos.changed", accountId, subjectId: installationId, payload: { kind, inserted: counts.inserted, detached: counts.detached } });
    }
    return true;
  });
  const done = await atStage("write_rows", withPlatformOps(deps.platformOpsPool, async (ops) => {
    await ops.query("SELECT pg_advisory_xact_lock($1::bigint)", [ghInstallationId]);
    const rec = await ops.query<{ deleted_at: Date | null; suspended_at: Date | null }>(
      "SELECT deleted_at, suspended_at FROM installation_installers WHERE gh_installation_id = $1 AND app_kind = $2",
      [ghInstallationId, kind],
    );
    const live = rec.rows[0];
    if (!live || live.deleted_at || live.suspended_at) return "inactive" as const;
    return writeRows();
  }));
  if (done === "inactive") return { status: "skipped", reason: "inactive" };
  return done ? { status: "synced", ...counts, skippedInvalid } : { status: "skipped", reason: "unclaimed" };
}

/** Injected by the routes; runs `syncInstallationRepos` with production deps. */
export type SyncRepos = (installationId: string) => Promise<unknown>;

/**
 * D#2 H17b-2: the post-commit, failure-tolerant trigger. Call it only AFTER the
 * claim/webhook transaction has committed. Whatever goes wrong is swallowed and
 * reported as one fixed line (no token, no name, no id); the next event retries.
 */
export async function syncClaimedInstallation(
  deps: { platformOpsPool: Pool; syncRepos?: SyncRepos; warn?: (message: string) => void },
  kind: string,
  ghInstallationId: number,
): Promise<void> {
  if (!deps.syncRepos) {
    console.info(`github repo sync: not wired (${kind})`);
    return;
  }
  try {
    const id = await atStage("find_installation", withPlatformOps(deps.platformOpsPool, async (c) => {
      const r = await c.query<{ id: string }>("SELECT id FROM installations WHERE gh_installation_id = $1 AND app_kind = $2", [ghInstallationId, kind]);
      return r.rows[0]?.id ?? null;
    }));
    if (!id) {
      console.info(`github repo sync: no installation row (${kind})`);
      return;
    }
    const result = (await deps.syncRepos(id)) as Record<string, unknown> | undefined;
    // Diagnostics: status, reason and counts only (fixed words and integers).
    const r = result ?? {};
    const num = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : "?");
    console.info(`github repo sync: ${String(r.status ?? "none").replace(/[^a-z_]/g, "")} ${String(r.reason ?? "").replace(/[^a-z_]/g, "")} inserted=${num(r.inserted)} updated=${num(r.updated)} repointed=${num(r.repointed)} detached=${num(r.detached)} skipped_invalid=${num(r.skippedInvalid)} (${kind})`);
  } catch (err) {
    (deps.warn ?? console.warn)(`github repo sync failed (${syncFailureTag(err)}); the next event retries`);
  }
}
