import type { PoolClient } from "pg";
import { reportError } from "@fx/telemetry";
import { emitSetupChanged } from "@fx/core/src/onboarding/engineTrack.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { requireEngineCoverage } from "./engineSession.js";
import { RunnerHttpError, pgCode, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";
import { requireMemberRole } from "./memberRole.js";
import { blockError, blockFor, readRepoVisibility } from "./repoPrivacy.js";
import { issueProjectSetup } from "./setupJobs.js";
import { startSurvey } from "./surveyJobs.js";

/**
 * D#845 ON-11a: the plan draft of a setup, read, edited, approved or thrown away by a person. Every route is a session route (no token, no runner): reads are for any member, every write for an owner or admin. Every query names the
 * account itself on top of row security, and a setup of another account answers the same 404 as one that does not exist.
 *
 * A draft's `version` is the repo's draft counter and doubles as the edit lock: a write names the version it read, and a write that lands makes the next number (409 `draft_conflict` for a stale one, with the current version).
 * `review_mode` is read live from the repo's visibility (nothing stored): anything but a clear "private" is `public`, which makes Approve also need every row and the PRD marked read (409 `plan_not_reviewed`).
 * Approve writes the approved version on the draft (and the setup on it), the audit row `project.plan_approved` and, when the Engine plan covers the project, issues the install (ON-8b). With no coverage it answers the gate and issues nothing.
 * Approving again before the install was issued is the same call, so it is how an issue that failed is tried again.
 * Refusals: 400 `invalid_message`; 403 `forbidden`; 404 `not_found`; 409 `draft_conflict`, `plan_invalid` (with `reason`), `plan_not_reviewed`, `setup_phase`, `survey_running`; and Start over's own (`public_repo` and the survey start's).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PRD = 200_000;
const refuse = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): RunnerHttpError => new RunnerHttpError(status, code, message, extra);
const ok = (body: unknown): RunnerHttpResponse => ({ status: 200, body, headers: { "cache-control": "no-store" } });
const bad = (): RunnerHttpError => refuse(400, "invalid_message", "the request body is not what this route takes");

interface Row { row_key: string; title: string; summary: string; size: string; depends_on: string[]; keep: boolean }
interface Draft { id: string; version: number; source: string; status: string; prd_md: string; roadmap: Row[]; created_at: Date }
interface Setup { id: string; repo_id: string; phase: string; state: string; survey_live: boolean }

const DRAFT_COLUMNS = "id, version, source, status, prd_md, roadmap, created_at";
const tenant = <T>(deps: RunnerCloudDeps, p: SessionPrincipal, fn: (client: PoolClient) => Promise<T>) => withTenant(deps.appUserPool, p.accountId, p.userId, fn);
const asOwner = async (client: PoolClient): Promise<void> => {
  const role = await requireMemberRole(client);
  if (role !== "owner" && role !== "admin") throw refuse(403, "forbidden", "only an owner or admin can change the plan");
};
const reviewMode = async (deps: RunnerCloudDeps, p: SessionPrincipal, repoId: string): Promise<"public" | "standard"> => ((await readRepoVisibility(deps, p.accountId, repoId)) === "private" ? "standard" : "public");
const shown = (d: Draft) => ({ id: d.id, version: d.version, source: d.source, status: d.status, prd_md: d.prd_md, roadmap: d.roadmap, created_at: d.created_at });
const object = (body: unknown): Record<string, unknown> => { if (typeof body !== "object" || body === null || Array.isArray(body)) throw bad(); return body as Record<string, unknown>; };

async function loadSetup(client: PoolClient, accountId: string, setupId: string, lock: boolean): Promise<Setup> {
  const { rows } = await client.query<Setup>(
    `SELECT s.id, s.repo_id, s.phase, s.state, EXISTS (SELECT 1 FROM agent_runs a WHERE a.account_id = s.account_id AND a.id = s.survey_run_id AND a.status IN ('pending', 'running', 'paused')) AS survey_live
       FROM project_setups s WHERE s.account_id = $1 AND s.id = $2${lock ? " FOR UPDATE OF s" : ""}`,
    [accountId, setupId],
  );
  if (!rows[0]) throw refuse(404, "not_found", "no such setup");
  return rows[0];
}

/** The setup's newest draft that was not thrown away (an open one, or the approved one). */
async function latestDraft(client: PoolClient, accountId: string, setup: Setup): Promise<Draft | null> {
  return (await client.query<Draft>(`SELECT ${DRAFT_COLUMNS} FROM project_drafts WHERE account_id = $1 AND repo_id = $2 AND setup_id = $3 AND status <> 'discarded' ORDER BY version DESC LIMIT 1`, [accountId, setup.repo_id, setup.id])).rows[0] ?? null;
}

/** An open draft is what a person edits: refused when the plan is no longer at the plan step, or already approved. */
async function openDraft(client: PoolClient, accountId: string, setup: Setup): Promise<Draft> {
  if (setup.phase !== "plan") throw refuse(409, "setup_phase", "the setup is not at the plan step");
  const draft = await latestDraft(client, accountId, setup);
  if (!draft) throw refuse(404, "not_found", "no draft for this setup");
  if (draft.status !== "draft") throw refuse(409, "setup_phase", "the plan was already approved");
  return draft;
}

const lockRepoDrafts = (client: PoolClient, repoId: string) => client.query("SELECT pg_advisory_xact_lock(hashtextextended('project_draft:' || $1::text, 0))", [repoId]);
const changed = (client: PoolClient, accountId: string, setup: Setup) => emitSetupChanged(client, { accountId, setupId: setup.id, repoId: setup.repo_id });
const discard = (client: PoolClient, accountId: string, id: string) => client.query("UPDATE project_drafts SET status = 'discarded', final_at = now() WHERE account_id = $1 AND id = $2 AND status = 'draft'", [accountId, id]);
const toPlan = (client: PoolClient, accountId: string, setupId: string) =>
  client.query("UPDATE project_setups SET phase = 'plan', state = 'ok', sub_step = NULL, failure_code = NULL, failure_reason = NULL, failure_at = NULL, updated_at = now() WHERE account_id = $1 AND id = $2", [accountId, setupId]);

/** GET /api/v1/setups/:id/draft. */
export async function readDraft(deps: RunnerCloudDeps, p: SessionPrincipal, setupId: string): Promise<RunnerHttpResponse> {
  const { setup, draft } = await tenant(deps, p, async (client) => {
    await requireMemberRole(client);
    const s = await loadSetup(client, p.accountId, setupId, false);
    return { setup: s, draft: await latestDraft(client, p.accountId, s) };
  });
  if (!draft) throw refuse(404, "not_found", "no draft for this setup");
  return ok({ setup: { phase: setup.phase, state: setup.state }, draft: shown(draft), review_mode: await reviewMode(deps, p, setup.repo_id) });
}

/** PUT /api/v1/setups/:id/draft {version, prd_md, roadmap}. */
async function putDraft(deps: RunnerCloudDeps, p: SessionPrincipal, setupId: string, body: unknown): Promise<RunnerHttpResponse> {
  const b = object(body);
  if (!Number.isInteger(b["version"]) || (b["version"] as number) < 1 || typeof b["prd_md"] !== "string" || !Array.isArray(b["roadmap"])) throw bad();
  return tenant(deps, p, async (client) => {
    await asOwner(client);
    const setup = await loadSetup(client, p.accountId, setupId, true);
    const draft = await openDraft(client, p.accountId, setup);
    if (draft.version !== b["version"]) throw refuse(409, "draft_conflict", "the plan changed since you opened it", { version: draft.version });
    await lockRepoDrafts(client, setup.repo_id);
    try {
      const { rows } = await client.query<{ version: number }>(
        `UPDATE project_drafts SET prd_md = $4, roadmap = $5::jsonb, version = (SELECT max(m.version) + 1 FROM project_drafts m WHERE m.account_id = $1 AND m.repo_id = $2)
          WHERE account_id = $1 AND repo_id = $2 AND id = $3 AND status = 'draft' RETURNING version`,
        [p.accountId, setup.repo_id, draft.id, b["prd_md"], JSON.stringify(b["roadmap"])],
      );
      return ok({ version: rows[0]!.version });
    } catch (error) {
      // 23514: the table's own shape check; 22021 and 22P05: text the database cannot hold.
      if (["23514", "22021", "22P05"].includes(pgCode(error) ?? "")) throw bad();
      throw error;
    }
  });
}

/** Approve's checks and writes, in the person's transaction: the plan must be one the engine can be installed from, and (public mode) read in full. */
async function approveInTx(client: PoolClient, p: SessionPrincipal, setup: Setup, b: Record<string, unknown>, mode: "public" | "standard"): Promise<Draft> {
  if (setup.phase !== "plan") throw refuse(409, "setup_phase", "the setup is not at the plan step");
  const draft = await latestDraft(client, p.accountId, setup);
  if (!draft) throw refuse(404, "not_found", "no draft for this setup");
  const kept = draft.roadmap.filter((r) => r.keep);
  // An approved plan that was not installed yet is approved again without a version: nothing is written, only the issue is tried again.
  if (draft.status === "approved") return draft;
  if (b["version"] !== draft.version) throw refuse(409, "draft_conflict", "the plan changed since you opened it", { version: draft.version });
  // The column check counts code points, not UTF-16 units.
  const prdLength = [...draft.prd_md].length;
  const keptKeys = new Set(kept.map((r) => r.row_key));
  const reason = kept.length === 0 ? "no_kept_rows" : prdLength < 1 || prdLength > MAX_PRD ? "prd_length" : kept.some((r) => r.depends_on.some((d) => !keptKeys.has(d))) ? "dependency_dropped" : null;
  if (reason !== null) throw refuse(409, "plan_invalid", "the plan cannot be approved as it is", { reason });
  if (mode === "public") {
    const seen = b["reviewed_row_keys"];
    if (!Array.isArray(seen) || !seen.every((k) => typeof k === "string") || (b["prd_reviewed"] !== undefined && typeof b["prd_reviewed"] !== "boolean")) throw bad();
    const all = new Set(draft.roadmap.map((r) => r.row_key));
    const given = new Set(seen as string[]);
    const missing = [...all].filter((k) => !given.has(k)).length + [...given].filter((k) => !all.has(k)).length + (b["prd_reviewed"] === true ? 0 : 1);
    if (missing > 0) throw refuse(409, "plan_not_reviewed", "read every item before you approve", { missing });
  }
  const moved = await client.query("UPDATE project_drafts SET status = 'approved', approved_by = $3, approved_at = now(), final_at = now(), setup_id = $4 WHERE account_id = $1 AND id = $2 AND status = 'draft'", [p.accountId, draft.id, p.userId, setup.id]);
  // No audit row for an approval that did not land.
  if (moved.rowCount !== 1) throw refuse(409, "setup_phase", "the plan was changed while it was approved");
  await client.query("SELECT audit_write('project.plan_approved', $1::jsonb)", [JSON.stringify({ setup_id: setup.id, repo_id: setup.repo_id, draft_id: draft.id, version: draft.version, review_mode: mode, reviewed_count: mode === "public" ? draft.roadmap.length : 0, kept_count: kept.length })]);
  await changed(client, p.accountId, setup);
  return draft;
}

/** POST .../draft/approve {version, reviewed_row_keys?, prd_reviewed?}. */
async function approve(deps: RunnerCloudDeps, p: SessionPrincipal, setupId: string, body: unknown): Promise<RunnerHttpResponse> {
  const b = object(body);
  const repoId = await tenant(deps, p, async (client) => (await asOwner(client), (await loadSetup(client, p.accountId, setupId, false)).repo_id));
  const mode = await reviewMode(deps, p, repoId);
  const done = await tenant(deps, p, async (client) => {
    await asOwner(client);
    const setup = await loadSetup(client, p.accountId, setupId, true);
    const draft = await approveInTx(client, p, setup, b, mode);
    let gate: { code: string; message: string; data?: unknown } | null = null;
    try {
      await requireEngineCoverage(client, p.accountId, setup.repo_id);
    } catch (error) {
      if (!(error instanceof RunnerHttpError) || ![402, 503].includes(error.status)) throw error;
      gate = { code: error.code, message: error.message, ...(Object.keys(error.extra).length > 0 ? { data: error.extra } : {}) };
    }
    return { draft, gate };
  });
  // The approval is committed: an install that cannot be issued now is reported next to it, and approving again tries it again.
  let install: { job_id: string; attempt: number } | null = null;
  let installError: { code: string; message: string } | null = null;
  if (done.gate === null) {
    try {
      install = await issueProjectSetup(deps, p, setupId.toLowerCase(), { fromApprove: true });
    } catch (error) {
      // Anything the issuer throws after the commit is reported next to the approval, never as a 500.
      if (!(error instanceof RunnerHttpError)) reportError(error, { stage: "plan_draft.install", route: "/api/v1/setups/:id/draft/approve" });
      installError = error instanceof RunnerHttpError ? { code: error.code, message: error.message } : { code: "install_error", message: "the install could not be issued now" };
    }
  }
  return ok({ approved: true, draft_id: done.draft.id, version: done.draft.version, review_mode: mode, install, gate: done.gate, install_error: installError });
}

/** POST .../draft/discard: the open draft is thrown away. POST .../draft/blank ("Write my own"): the open draft, if any, is replaced by an empty one, and the setup is at the plan step. */
async function discardOrBlank(deps: RunnerCloudDeps, p: SessionPrincipal, setupId: string, blank: boolean): Promise<RunnerHttpResponse> {
  return tenant(deps, p, async (client) => {
    await asOwner(client);
    const setup = await loadSetup(client, p.accountId, setupId, true);
    if (!blank) await discard(client, p.accountId, (await openDraft(client, p.accountId, setup)).id);
    else {
      if (setup.phase !== "plan" && setup.phase !== "survey") throw refuse(409, "setup_phase", "the setup is not at the survey or plan step");
      if (setup.phase === "survey" && setup.survey_live) throw refuse(409, "survey_running", "a survey is running");
      const open = await latestDraft(client, p.accountId, setup);
      if (open?.status === "approved") throw refuse(409, "setup_phase", "the plan was already approved");
      if (open) await discard(client, p.accountId, open.id);
      await lockRepoDrafts(client, setup.repo_id);
      await client.query(
        "INSERT INTO project_drafts (account_id, repo_id, setup_id, source, prd_md, roadmap, version) VALUES ($1, $2, $3, 'blank', '', '[]'::jsonb, (SELECT COALESCE(max(m.version), 0) + 1 FROM project_drafts m WHERE m.account_id = $1 AND m.repo_id = $2))",
        [p.accountId, setup.repo_id, setup.id],
      );
      await toPlan(client, p.accountId, setup.id);
    }
    await changed(client, p.accountId, setup);
    return ok({ discarded: !blank, blank });
  });
}

/** POST .../draft/restart ("Start over"): the open draft is thrown away and a new survey starts. A public repo, or one whose visibility cannot be read, is refused before anything is written; a start that fails after the move puts the draft and the step back. */
async function restart(deps: RunnerCloudDeps, p: SessionPrincipal, setupId: string): Promise<RunnerHttpResponse> {
  const first = await tenant(deps, p, async (client) => (await asOwner(client), loadSetup(client, p.accountId, setupId, false)));
  const block = blockFor(await readRepoVisibility(deps, p.accountId, first.repo_id));
  if (block !== null) throw blockError(block);
  const old = await tenant(deps, p, async (client) => {
    await asOwner(client);
    const setup = await loadSetup(client, p.accountId, setupId, true);
    const draft = await openDraft(client, p.accountId, setup);
    await discard(client, p.accountId, draft.id);
    await client.query("UPDATE project_setups SET phase = 'survey', state = 'ok', updated_at = now() WHERE account_id = $1 AND id = $2", [p.accountId, setup.id]);
    await changed(client, p.accountId, setup);
    return draft.id;
  });
  try {
    return ok(await startSurvey(deps, p, setupId));
  } catch (error) {
    await tenant(deps, p, async (client) => {
      await client.query("UPDATE project_drafts SET status = 'draft', final_at = NULL WHERE account_id = $1 AND id = $2 AND status = 'discarded'", [p.accountId, old]);
      await toPlan(client, p.accountId, setupId);
    });
    throw error;
  }
}

/** The routes below /api/v1/setups/:id/draft: GET and PUT on it, and POST on `approve`, `discard`, `blank` and `restart`. */
export async function draftRoute(deps: RunnerCloudDeps, p: SessionPrincipal, method: "GET" | "PUT" | "POST", setupId: string, action: string | null, body: unknown): Promise<RunnerHttpResponse> {
  if (!UUID.test(setupId)) throw refuse(404, "not_found", "no such setup");
  const id = setupId.toLowerCase();
  if (action === null && method === "GET") return readDraft(deps, p, id);
  if (action === null && method === "PUT") return putDraft(deps, p, id, body);
  if (method !== "POST") throw refuse(404, "not_found", "no such route");
  if (action === "approve") return approve(deps, p, id, body);
  if (action === "discard" || action === "blank" || action === "restart") {
    if (body !== null && body !== undefined) throw bad();
    return action === "restart" ? restart(deps, p, id) : discardOrBlank(deps, p, id, action === "blank");
  }
  throw refuse(404, "not_found", "no such route");
}
