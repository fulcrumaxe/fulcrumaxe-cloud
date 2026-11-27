import { z } from "zod";
import type { PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { deleteEngineData, readEnginePanelAsOf, readEngineRepoFreshness, readEngineSettingsView, setEngineBridgeSettings, EngineOperateRefusal, type EnginePanel } from "@fx/db/src/engineBridge.js";
import { readEngineUsage } from "@fx/core/src/engine/read.js";
import { markRunnerWork, markWorkPending } from "@fx/core/src/pendingWork.js";
import {
  CursorError,
  engineRepoEnabled,
  freshnessWithSeen,
  readAgents,
  readAsks,
  readEngineRepos,
  readGates,
  readLanes,
  readLog,
  readRepoStats,
  toFreshness,
  type Envelope,
} from "@fx/core/src/engine/panels.js";
import { assertRepoIdShape } from "@fx/core/src/repos/read.js";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";
import { readEngineUpdateCard } from "@fx/runner-cloud";
import { ApiError, InvalidCursorError } from "../errors.js";
import { parseLimit } from "../pagination.js";
import type { RouteEntry } from "../registry.js";
import { resolveWindow } from "./stats.js";

/**
 * Engine bridge EB-5: what a person's own engine reported, read back (`GET /api/v1/engine/*`), and the two switches that turn the bridge on. Every route
 * names its principals and its role itself (L3: nothing defaults to open) and runs on the caller's tenant client, so row security is the only reader.
 *
 *  - Reads: any member, a session or a `read` token. A repo that is not ticked, or is another account's, is a 404.
 *  - Every per-repo list is one envelope, `{items, next_cursor, as_of, heard_age_s, source_ages_s, gaps, missing_events}`: the age and the holes sit at
 *    the top level so every panel reads them the same way (L1, L2).
 *  - Nothing here is text the engine wrote: ids, enums, counts, timestamps and cloud-side names only. Dollar figures come from the cloud's own pricing.
 *  - Settings: PUT is an owner or admin on a session; delete-data is an owner on a session. Each change writes its audit row in the same transaction.
 *  - `engine.changed` (ids and the names of the changed panels only) reaches `/api/v1/events` (SSE and JSON) for the account; it is not a webhook type.
 */

/** Whether a repo is private, asked of GitHub on every call and never remembered. Anything but a clear "private" or "public" is refused (fail closed). Production registers it. */
export const engineSettingsDeps: { getVisibility: (() => (accountId: string, repoId: string) => Promise<"private" | "public" | "unknown">) | null } = { getVisibility: null };

const READ = { principals: ["session", "token"] as ("session" | "token")[], scope: "read" as const, minRole: "member" as const, idempotency: "never" as const, rateClass: "read" };
const idParams = z.object({ id: z.string() });
const listQuery = z.object({ limit: z.string().optional(), cursor: z.string().optional() });
const windowQuery = z.object({ from: z.string().optional(), to: z.string().optional() });

const freshnessShape = {
  next_cursor: z.string().nullable(),
  as_of: z.string(),
  heard_age_s: z.number().nullable(),
  source_ages_s: z.record(z.string(), z.number()),
  gaps: z.array(z.object({ from_seq: z.number(), to_seq: z.number(), before_ts: z.string().nullable() })),
  missing_events: z.number(),
  held_events: z.number().int(),
  oldest_seq: z.number().int().nullable(),
};
const envelope = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item), ...freshnessShape });
const num = z.number();
const nnum = z.number().nullable();
const nstr = z.string().nullable();

const repoItem = z.object({
  repo_id: z.string(), full_name: z.string(), runner_id: nstr, runner_name: nstr, session_id: nstr, last_event_at: nstr, last_heard_at: nstr,
  liveness: z.enum(["live", "stale", "runner_removed", "never"]), watch_enabled: z.boolean(), operate_enabled: z.boolean(), halted: z.boolean(), halt_pending: z.boolean(),
  halted_at: nstr, halted_by: z.object({ id: z.string(), display_name: z.string() }).nullable(), halt_epoch: z.number().int(),
  stop_failed: z.object({ reason: z.enum(["person", "halt", "move", "remove", "operate_off", "plan"]).nullable(), code: nstr, at: z.string() }).nullable(),
  machine_name: nstr,
  setup: z.object({ status: z.enum(["none", "open", "done"]), phase: nstr, sub_step: nstr, state: z.enum(["started", "ok", "failed"]).nullable(), failure_code: nstr }),
  session: z.object({
    state: z.enum(["never", "starting", "running", "stale", "stopped", "halted", "runner_removed"]),
    last_start_mode: z.enum(["created", "resumed", "fresh"]).nullable(), last_start_at: nstr,
    stopped_reason: z.enum(["person", "halt", "move", "remove", "operate_off", "plan"]).nullable(), state_at: nstr,
  }),
  quota: z.object({ state: z.enum(["ok", "session_full", "repo_full"]), session_used: z.number().int(), session_limit: z.number().int(), repo_used: z.number().int(), repo_limit: z.number().int(), resets_at: z.string() }),
  engine_update: z.object({
    behind: z.object({ from: z.string(), to: z.string() }).nullable(),
    update: z.object({ from_version: z.string(), to_version: z.string(), phase: z.enum(["push", "pr", "await_merge", "restart", "done", "failed"]), sub_step: nstr, state: z.enum(["started", "ok", "failed", "skipped"]), failure_code: nstr, pr: nnum }).nullable(),
  }).nullable(),
});
const agentItem = z.object({
  agent_id: z.string(), role: z.string(), discussion: nnum, background: z.boolean().nullable(), started_at: nstr, stopped_at: nstr, verdict: nstr,
  state: z.enum(["running", "unknown", "stopped"]), model: nstr, credential_mode: nstr,
});
const laneItem = z.object({ pr: num, discussion: nnum, state: z.string(), updated_at: z.string() });
const gateItem = z.object({ pr: num, gate: z.string(), result: z.string(), head_sha: z.string(), at: z.string() });
const askItem = z.object({ ask_id: z.string(), ask_kind: z.string(), source: z.string(), discussion: nnum, pr: nnum, raised_at: z.string(), cleared_at: nstr, how: nstr,
  decision_id: z.string().uuid().nullable(), decision_type: z.enum(["engine_spawn", "engine_merge", "engine_spec_ready"]).nullable(),
});
const logItem = z.object({ line_id: z.string(), actor_role: z.string(), category: z.string(), discussion: nnum, pr: nnum, ts: z.string() });
const provenance = z.object({ kinds: z.array(z.string()), count: num, seqs: z.array(z.object({ session_id: z.string(), seq: num })) });
const usageItem = z.object({
  subject_kind: z.enum(["agent", "tick"]), subject_id: z.string(), model: nstr, credential_mode: nstr,
  tokens: z.object({ input: num, output: num, cache_read: num, cache_write: num }).nullable(), api_equivalent_usd: nnum,
  state: z.enum(["recorded", "not_priced", "not_recorded"]).nullable(), note: nstr, provenance: z.object({ session_id: z.string(), seqs: z.array(num) }),
});
const freshOnly = z.object(freshnessShape);
const windowShape = z.object({ from: z.string(), to: z.string() });
const usageResponse = envelope(usageItem).extend({ window: windowShape, totals: z.object({ api_equivalent_usd: num, tokens: z.object({ input: num, output: num, cache_read: num, cache_write: num }) }) });
const statsResponse = freshOnly.extend({
  window: windowShape,
  agents_by_role: z.object({ value: z.record(z.string(), z.number()), provenance }),
  duration_s: z.object({ n: num, median: nnum, p90: nnum, provenance }),
  merges: z.object({ value: num, provenance }),
  gate_pass_rate: z.object({ value: nnum, numerator: num, denominator: num, provenance }),
});
const settingsResponse = z.object({
  watch_enabled: z.boolean(), operate_enabled: z.boolean(), can_edit: z.boolean(),
  repos: z.array(z.object({ repo_id: z.string(), full_name: z.string(), enabled: z.boolean(), eligible: z.boolean(), refusal: z.enum(["repo_not_runner_local", "repo_visibility_unknown"]).nullable(), bridged_runner_id: z.string().uuid().nullable() })),
});
const settingsBody = z.object({ watch_enabled: z.boolean().optional(), operate_enabled: z.boolean().optional(), repo_ids: z.array(z.string().uuid()).max(500).optional() }).strict();

/** Runs a per-repo read on the tenant client: 404 for a repo the account has not ticked (or does not have), 422 for a forged cursor. */
async function onRepo<T>(ctx: Parameters<RouteEntry["handler"]>[0], id: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
  assertRepoIdShape(id);
  const { accountId, userId } = ctx.principal;
  try {
    return await withTenant(ctx.pool, accountId, userId, async (client) => {
      if (!(await engineRepoEnabled(client, id))) throw new NotFoundError(`repo ${id} not found`);
      return run(client);
    });
  } catch (error) {
    if (error instanceof CursorError || (typeof (error as { code?: unknown } | null)?.code === "string" && /^22/.test((error as { code: string }).code))) throw new InvalidCursorError();
    throw error;
  }
}

/**
 * The envelope's age and holes, with the runner's wake stamp folded into `heard_age_s` (the account's own runner only). `as_of` is the panel's own: when the newest event that panel
 * reads reached the cloud. A panel that has had no event yet keeps the repo-wide stamp, so it never reads "no time".
 */
async function freshOf(ctx: Parameters<RouteEntry["handler"]>[0], client: PoolClient, id: string, panel: EnginePanel) {
  const { accountId } = ctx.principal;
  const fresh = toFreshness(await freshnessWithSeen(client, accountId, id, await readEngineRepoFreshness(client, id, accountId)));
  return { ...fresh, as_of: (await readEnginePanelAsOf(client, accountId, id, panel)) ?? fresh.as_of };
}

async function listOf<T>(ctx: Parameters<RouteEntry["handler"]>[0], id: string, panel: EnginePanel, read: (client: PoolClient) => Promise<{ items: T[]; next_cursor: string | null }>): Promise<Envelope<T>> {
  return onRepo(ctx, id, async (client) => ({ ...(await read(client)), ...(await freshOf(ctx, client, id, panel)) }));
}

const q = <S extends z.ZodTypeAny>(input: { query: unknown }) => (input.query ?? {}) as z.infer<S>;
const sum = (rows: Array<{ tokens: { input: number; output: number; cache_read: number; cache_write: number } | null }>) =>
  rows.reduce((t, r) => ({ input: t.input + (r.tokens?.input ?? 0), output: t.output + (r.tokens?.output ?? 0), cache_read: t.cache_read + (r.tokens?.cache_read ?? 0), cache_write: t.cache_write + (r.tokens?.cache_write ?? 0) }), { input: 0, output: 0, cache_read: 0, cache_write: 0 });

/**
 * The settings read: the switches and every repo with whether it can be ticked. A repo is eligible if it is `runner_local` and GitHub answered whether it is public or
 * private (D#845 O-9: public is accepted). GitHub is asked now (never remembered) for each `runner_local` repo, or only for `only` when given, and the ids with no clear
 * answer go to `readEngineSettingsView` as its `unknownRepoIds` (fail closed: a missing reader, a rejected call, a 404 or a 5xx counts as unknown).
 */
async function settingsView(ctx: Parameters<RouteEntry["handler"]>[0], canEdit: boolean, only?: ReadonlySet<string>) {
  const { accountId, userId } = ctx.principal;
  const base = await withTenant(ctx.pool, accountId, userId, (client) => readEngineSettingsView(client, canEdit));
  const unknown = new Set<string>();
  await Promise.all(
    base.repos
      .filter((r) => r.eligible && (only === undefined || only.has(r.repo_id)))
      .map(async (r) => {
        if ((await visibilityOf(accountId, r.repo_id)) === "unknown") unknown.add(r.repo_id);
      }),
  );
  return unknown.size === 0 ? base : withTenant(ctx.pool, accountId, userId, (client) => readEngineSettingsView(client, canEdit, unknown));
}

/** One GitHub visibility question, failing closed: a missing reader, a reader that throws (even before it returns a promise) or rejects, all read as "unknown". */
async function visibilityOf(accountId: string, repoId: string): Promise<"private" | "public" | "unknown"> {
  try {
    const ask = engineSettingsDeps.getVisibility?.();
    return ask ? await ask(accountId, repoId) : "unknown";
  } catch {
    // fx-swallow-ok: any failure of the GitHub read is the same answer, "unknown", which the caller treats as not private and refuses the tick
    return "unknown";
  }
}

export const engineRoutes: RouteEntry[] = [
  {
    method: "GET", path: "/api/v1/engine/repos", operationId: "listEngineRepos", ...READ,
    summary: "The repos ticked for the engine bridge, with the runner that serves each and whether it is live, stale, removed or never connected",
    responseSchema: envelope(repoItem),
    async handler(ctx) {
      const { accountId, userId } = ctx.principal;
      return withTenant(ctx.pool, accountId, userId, async (client) => {
        // The update card of each installed repo (ON-15d), read on the same tenant client and named by account as well as repo.
        const items: Array<Awaited<ReturnType<typeof readEngineRepos>>[number] & { engine_update: Awaited<ReturnType<typeof readEngineUpdateCard>> }> = [];
        for (const row of await readEngineRepos(client, accountId)) items.push({ ...row, engine_update: await readEngineUpdateCard(client, accountId, row.repo_id) });
        const newest = items.map((i) => i.last_heard_at).filter((x): x is string => x !== null).sort().pop() ?? null;
        const heard = newest === null ? null : Math.max(0, Math.round((Date.now() - Date.parse(newest)) / 1000));
        return { items, next_cursor: null, as_of: newest ?? new Date().toISOString(), heard_age_s: heard, source_ages_s: {}, gaps: [], missing_events: 0, held_events: 0, oldest_seq: null };
      });
    },
  },
  {
    method: "GET", path: "/api/v1/engine/repos/{id}/agents", operationId: "listEngineAgents", ...READ,
    summary: "The repo's agents: `state=running` (running or unknown, never stopped) or `state=recent` (stopped in the last 24 hours)",
    paramsSchema: idParams, querySchema: listQuery.extend({ state: z.enum(["running", "recent"]).optional() }), responseSchema: envelope(agentItem),
    handler: (ctx, input) => {
      const query = q<typeof listQuery>(input) as z.infer<typeof listQuery> & { state?: "running" | "recent" };
      const limit = parseLimit(query.limit);
      return listOf(ctx, input.params.id!, "agents", (c) => readAgents(c, input.params.id!, query.state ?? "running", limit, query.cursor, ctx.principal.accountId));
    },
  },
  {
    method: "GET", path: "/api/v1/engine/repos/{id}/lanes", operationId: "listEngineLanes", ...READ,
    summary: "The merge lane: each PR with its newest state",
    paramsSchema: idParams, querySchema: listQuery, responseSchema: envelope(laneItem),
    handler: (ctx, input) => {
      const query = q<typeof listQuery>(input);
      return listOf(ctx, input.params.id!, "lanes", (c) => readLanes(c, input.params.id!, parseLimit(query.limit), query.cursor));
    },
  },
  {
    method: "GET", path: "/api/v1/engine/repos/{id}/gates", operationId: "listEngineGates", ...READ,
    summary: "Gate results: with no `pr`, the latest per (PR, gate) for PRs in a lane or changed in the last 24 hours; with `pr=N`, that PR's latest per gate",
    paramsSchema: idParams, querySchema: listQuery.extend({ pr: z.string().regex(/^[1-9][0-9]{0,14}$/).optional() }), responseSchema: envelope(gateItem),
    handler: (ctx, input) => {
      const query = q<typeof listQuery>(input) as z.infer<typeof listQuery> & { pr?: string };
      return listOf(ctx, input.params.id!, "gates", (c) => readGates(c, input.params.id!, query.pr === undefined ? null : Number(query.pr), parseLimit(query.limit), query.cursor));
    },
  },
  {
    method: "GET", path: "/api/v1/engine/repos/{id}/asks", operationId: "listEngineAsks", ...READ,
    summary: "The engine's open questions (`state=open`, the default) or all of them",
    description: "Team-log asks and decision asks in one list. A decision ask (`source: decide`, `ask_kind: owner_decision`) carries `decision_id` and `decision_type`, and is answered with `POST /engine/decisions/{id}/answer`; its answer clears it. A team-log ask has both fields null.",
    paramsSchema: idParams, querySchema: listQuery.extend({ state: z.enum(["open", "all"]).optional() }), responseSchema: envelope(askItem),
    handler: (ctx, input) => {
      const query = q<typeof listQuery>(input) as z.infer<typeof listQuery> & { state?: "open" | "all" };
      return listOf(ctx, input.params.id!, "asks", (c) => readAsks(c, input.params.id!, query.state ?? "open", parseLimit(query.limit), query.cursor, ctx.principal.accountId));
    },
  },
  {
    method: "GET", path: "/api/v1/engine/repos/{id}/log", operationId: "listEngineLog", ...READ,
    summary: "The team log by kind of line, newest first, 200 lines at most a page (the text of a line never leaves the person's machine)",
    paramsSchema: idParams, querySchema: listQuery, responseSchema: envelope(logItem),
    handler: (ctx, input) => {
      const query = q<typeof listQuery>(input);
      return listOf(ctx, input.params.id!, "log", (c) => readLog(c, input.params.id!, parseLimit(query.limit), query.cursor));
    },
  },
  {
    method: "GET", path: "/api/v1/engine/repos/{id}/usage", operationId: "getEngineUsage", ...READ,
    summary: "Tokens and the cloud's own API-equivalent dollar figure for each agent and tick in a window, with a state and note where a figure is missing",
    description: "Information, never spend. A figure that is missing is shown with its state (`not_priced`, `not_recorded`), never as 0.",
    paramsSchema: idParams, querySchema: windowQuery, responseSchema: usageResponse,
    handler: (ctx, input) => {
      const w = resolveWindow(q<typeof windowQuery>(input), new Date());
      return onRepo(ctx, input.params.id!, async (client) => {
        const u = await readEngineUsage(client, { ...w, repoId: input.params.id! });
        return {
          items: u.rows, next_cursor: null, ...(await freshOf(ctx, client, input.params.id!, "usage")),
          window: { from: w.from.toISOString(), to: w.to.toISOString() }, totals: { api_equivalent_usd: u.total_api_equivalent_usd, tokens: sum(u.rows) },
        };
      });
    },
  },
  {
    method: "GET", path: "/api/v1/engine/repos/{id}/stats", operationId: "getEngineStats", ...READ,
    summary: "Agents by role, median and p90 duration, merges and gate pass rate for a window, each with the events it counted",
    paramsSchema: idParams, querySchema: windowQuery, responseSchema: statsResponse,
    handler: (ctx, input) => {
      const w = resolveWindow(q<typeof windowQuery>(input), new Date());
      return onRepo(ctx, input.params.id!, async (client) => ({
        ...(await readRepoStats(client, input.params.id!, w.from, w.to)),
        ...(await freshOf(ctx, client, input.params.id!, "stats")),
        window: { from: w.from.toISOString(), to: w.to.toISOString() },
      }));
    },
  },
  {
    method: "GET", path: "/api/v1/engine/settings", operationId: "getEngineSettings", ...READ,
    summary: "The watch and operate switches and each repo's tick, with why a repo cannot be ticked",
    responseSchema: settingsResponse,
    handler: (ctx) => settingsView(ctx, ctx.principal.role === "owner" || ctx.principal.role === "admin"),
  },
  {
    method: "PUT", path: "/api/v1/engine/settings", operationId: "setEngineSettings",
    summary: "Turn the engine watch or operate switch on or off and tick repos (an owner or admin, on a session)",
    description: "A repo that is not on one of the person's runners, or whose visibility GitHub did not answer, is refused with 409 (`repo_not_runner_local`, `repo_visibility_unknown`); a public repo is accepted. Operate needs watch, so turn operate off before watch.",
    extraResponses: { "409": "A repo cannot be ticked (`repo_not_runner_local`, `repo_visibility_unknown`), or operate would cover a public repo (`operate_public_pending`)." },
    principals: ["session"], minRole: "admin", idempotency: "never", rateClass: "write",
    bodySchema: settingsBody, responseSchema: settingsResponse,
    async handler(ctx, input) {
      const body = input.body as z.infer<typeof settingsBody>;
      const { accountId, userId } = ctx.principal;
      const wanted = new Set(body.repo_ids ?? []);
      const before = await withTenant(ctx.pool, accountId, userId, (client) => readEngineSettingsView(client, true));
      const watch = body.watch_enabled ?? before.watch_enabled;
      const operate = body.operate_enabled ?? before.operate_enabled;
      if (operate && !watch) throw new ApiError(422, "invalid_input", "operate needs watch: turn operate off before watch", [{ path: "operate_enabled", code: "requires_watch" }]);
      const ticked = new Set(before.repos.filter((r) => r.enabled).map((r) => r.repo_id));
      const fresh = new Set([...wanted].filter((id) => !ticked.has(id)));
      // GitHub is asked only about a repo this call would newly tick; one already ticked is not re-checked here.
      const view = fresh.size === 0 ? before : await settingsView(ctx, true, fresh);
      const known = new Map(view.repos.map((r) => [r.repo_id, r]));
      for (const id of fresh) {
        const r = known.get(id);
        if (!r) throw new NotFoundError(`repo ${id} not found`);
        if (!r.eligible) throw new ApiError(409, r.refusal ?? "repo_not_runner_local", r.refusal === "repo_visibility_unknown" ? "GitHub didn't say whether that repository is public or private. Try again in a minute" : "that repository does not run on one of your runners");
      }
      // Operate on a public repo waits for the decide rule for work from strangers (D#845 S-8). The follow-up that replaces this gate stores `repos.is_private` (kept by the sync and
      // the webhooks) so decide can answer `ask` itself; that also covers a repo that turns public after operate is on, which this gate does not. The repos that would be operated
      // are read live when operate goes on (all of them) or when it is on and a repo is added (the new ones). Watch-only stays open.
      // What this pre-lock read saw goes to the locked write, which works out the operated set again from the committed state and refuses any repo not read as private (CWE-367).
      const operateRead = new Map<string, "private" | "public" | "unknown">();
      if (operate) {
        const finalSet = body.repo_ids === undefined ? [...ticked] : [...wanted];
        const toRead = !before.operate_enabled ? finalSet : finalSet.filter((id) => fresh.has(id));
        const seen = await Promise.all(toRead.map(async (id) => visibilityOf(accountId, id)));
        toRead.forEach((id, i) => operateRead.set(id.toLowerCase(), seen[i]!));
        if (seen.includes("public")) throw new ApiError(409, "operate_public_pending", "Operate isn't available for public repos yet. The engine can watch this repo, but won't act on it.");
        if (seen.includes("unknown")) throw new ApiError(409, "repo_visibility_unknown", "GitHub didn't say whether that repository is public or private. Try again in a minute");
      }
      try {
        await withTenant(ctx.pool, accountId, userId, (client) => setEngineBridgeSettings(client, userId, { watch_enabled: body.watch_enabled, operate_enabled: body.operate_enabled, repo_ids: body.repo_ids }, operateRead));
      } catch (error) {
        if (error instanceof EngineOperateRefusal) throw new ApiError(409, error.code, error.message);
        throw error;
      }
      // The runner learns of a change to the switches or the ticked set through the wake path (its command pull is a 10-minute safety net now): without this,
      // turning a repo or the whole bridge off would stop the runner only at its next pull.
      const tickedChanged = body.repo_ids !== undefined && (wanted.size !== ticked.size || [...wanted].some((id) => !ticked.has(id)));
      if (watch !== before.watch_enabled || operate !== before.operate_enabled || tickedChanged) void markRunnerWork(accountId);
      // D#845 ON-13a5: operate or watch going off, or a repo unticked, is a cause for the system stop pass to end that session. No stop is written in this request (the operate queue of ON-13c is the fast path);
      // marking the reconcile tick makes the pass list it on the next tick.
      const untickedRepo = body.repo_ids !== undefined && [...ticked].some((id) => !wanted.has(id));
      if ((before.operate_enabled && !operate) || (before.watch_enabled && !watch) || untickedRepo) void markWorkPending("reconcile");
      return settingsView(ctx, true);
    },
  },
  {
    method: "PUT", path: "/api/v1/engine/settings/delete-data", operationId: "deleteEngineData",
    summary: "Delete every engine event and read-model row of the account (an owner, on a session); the switches stay",
    principals: ["session"], minRole: "owner", idempotency: "never", rateClass: "write",
    responseSchema: z.object({ deleted_sessions: z.number() }),
    async handler(ctx) {
      const { accountId, userId } = ctx.principal;
      return { deleted_sessions: await withTenant(ctx.pool, accountId, userId, (client) => deleteEngineData(client)) };
    },
  },
];
