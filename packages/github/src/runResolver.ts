import type { Pool } from "pg";
import { reportError } from "@fx/telemetry";
import type { Product } from "@fx/gh-policy";
import type { ResolvedSandboxRun, SandboxRunResolver } from "./proxyDecision.js";

/**
 * D#2 H13c (correction C27, H13c-4): the production `resolveSandboxRun`
 * H13b (#140) left as an injected interface, `defaultSandboxRunResolver`
 * failing closed until this landed.
 *
 * Uses `agent_runs.dispatch_repo_id` -- 0605's dispatch-time SNAPSHOT of
 * which repo a run was dispatched against -- rather than a live
 * `work_items -> repos` join. 0605's own header explains why: the
 * identity a cancel (and now a proxy decision) acts on must not drift
 * after dispatch, whether from a deleted repo or a work_item's linkage
 * changing later. Reading `dispatch_repo_id` directly is also why this
 * file needs no `work_items` grant at all (migration 0619's own note).
 *
 * There is no tenant to scope a `withTenant` connection by until AFTER
 * the sandbox is resolved, so the lookup cannot run as app_user. It does
 * not run as platform_ops either (migration 0696): it calls the one
 * SECURITY DEFINER function `resolve_sandbox_run`, as a login whose only
 * privilege is EXECUTE on that function (`DATABASE_URL_GH_PROXY`).
 */

interface ResolverRow {
  role: string;
  product: string;
  gh_owner: string | null;
  gh_name: string | null;
  gh_installation_id: string;
  app_kind: string | null;
  is_preview: boolean;
}

/**
 * The one call this resolver ever makes. The lookup itself lives in migration
 * 0696's `resolve_sandbox_run`; the reasoning below describes that function.
 * (Migration 0707 changed the rule.) It looks only at live runs (pending, running
 * or paused) with this sandbox name and returns a row only when exactly one such
 * run exists. Executor runs on one PR share a name on purpose, so an ended earlier
 * run does not count and a fix round's live run resolves; an ended run on its own,
 * or a name shared by two live runs, resolves to nothing. `dispatch_repo_id` has no
 * ongoing foreign key (0605), so an INNER JOIN to `repos` already denies
 * a NULL or dangling `dispatch_repo_id` (no match, zero rows) with no
 * extra branch needed here. Same for `repos.installation_id` -> a NULL
 * or dangling value denies via the second INNER JOIN.
 *
 * `r.account_id = ar.account_id` and `i.account_id = r.account_id`
 * (C27's own directive: "the resolver must guarantee the repo owner
 * belongs to the installation's account") are redundant with two
 * existing DB-level guarantees -- 0605's `agent_runs_dispatch_repo_same_tenant`
 * trigger (dispatch_repo_id can only ever be set to a same-account repos
 * row) and `repos`' own composite FK to `installations (account_id, id)`
 * (a repo's installation_id can only ever name a same-account
 * installation) -- but the query says so explicitly rather than relying
 * on those triggers/FKs never being weakened or bypassed later. Belt and
 * suspenders, same reasoning 0605 itself uses for its own tenant check.
 *
 * Fix round 1 (security review NEEDS-FIX, D#2 C27, CWE-639): the two
 * account_id checks above guarantee this query picks the CORRECT
 * `installations` row by primary key, but `gh_installation_id` -- the
 * one value this query returns that actually crosses the trust boundary
 * into GitHub's own API -- has no UNIQUE constraint yet (S1, out of
 * scope for this PR; migration 0619's own header explains why). If a
 * duplicate `gh_installation_id` exists ANYWHERE in the table, under a
 * DIFFERENT account, picking the right row by id is not enough: the
 * value handed to GitHub for minting an installation token is the
 * numeric `gh_installation_id` itself, not this row's `id`, so a
 * collision elsewhere still lets one account's run mint a token scoped
 * to another account's GitHub installation. The `NOT EXISTS` guard below
 * denies whenever the resolved installation's `gh_installation_id` is
 * not unique across the whole table -- a defense the account_id joins
 * cannot provide, no matter how correct they are.
 */
const RESOLVE_QUERY = `SELECT role, product, gh_owner, gh_name, gh_installation_id, app_kind, is_preview
                         FROM public.resolve_sandbox_run($1)`;

const VALID_PRODUCTS = new Set<string>(["team", "sitekit"] satisfies Product[]);

/**
 * Builds the production resolver against a pool connected as the narrow
 * gh-proxy login (`DATABASE_URL_GH_PROXY`). Every deny path (no row, two live rows, only
 * terminal runs, a NULL/dangling `dispatch_repo_id`, a missing
 * installation, a missing owner/name, an unrecognized `product`, or any
 * DB error) returns `null` -- `decideProxyRequest` turns that into a
 * generic `sandbox_not_resolved` 403 with no detail about which of these
 * fired (H13, body criterion 6).
 */
export function createRunResolver(ghProxyPool: Pool): SandboxRunResolver {
  return async function resolveSandboxRunFromDb(sandboxName: string): Promise<ResolvedSandboxRun | null> {
    let rows: ResolverRow[];
    try {
      rows = (await ghProxyPool.query<ResolverRow>(RESOLVE_QUERY, [sandboxName])).rows;
    } catch (err) {
      // Any DB error denies (H13c-4). Reported server-side only (a coded class, never the error's text) --
      // never surfaced to the sandbox that gets the generic 403.
      reportError(err, { stage: "github.run_resolve" });
      return null;
    }

    if (rows.length !== 1) return null;
    const row = rows[0]!;

    if (row.gh_owner == null || row.gh_name == null) return null;
    if (!VALID_PRODUCTS.has(row.product)) return null;

    // bigint columns come back as strings from node-postgres.
    const installationId = Number(row.gh_installation_id);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) return null;

    return {
      role: row.role,
      product: row.product as Product,
      installationId,
      appKind: row.app_kind,
      owner: row.gh_owner,
      repo: row.gh_name,
      // Set only for a preview run, so every other run resolves exactly as before.
      ...(row.is_preview === true ? { isPreview: true } : {}),
    };
  };
}
