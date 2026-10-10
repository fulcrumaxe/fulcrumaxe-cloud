import type { PoolClient } from "pg";
import type { LocalOnlyEvent } from "@fulcrumaxe/runner-protocol";
import { RUN_PROGRESS_LIMITS, activityFor, type RunStage } from "./runProgress.js";
import { recordAgentActivityCappedOn, recordAgentActivityOn, recordRunStageOn } from "./runStatusWriter.js";

/**
 * D#6 C42-1: what a local runner's events become in `run_events`, so the readers that already draw a sandbox run's progress (the Pipeline
 * panel, the Runs Activity section) draw a runner run too. The rows are the ones the sandbox recorder writes (`agent.activity`,
 * `run.stage`, one `agent.activity.capped`) and they come out of the same rules (`activityFor`, `safeCommandLine`), with the same bounds
 * (`RUN_PROGRESS_LIMITS`). The raw `runner.event` row is stored as before; this adds the derived rows.
 *
 * Called from the events handler, inside its tenant transaction and after the lease fence, with the events that were stored just now
 * (so a batch sent twice adds nothing), already through the redaction pass. It never throws on a value it dislikes: a command that
 * fails the clean check is stored as its kind alone, and an event with nothing safe to say makes no row.
 */

/** The raw `runner.event` rows kept per run for `tool_use` and `file_changed`; every other event type is always stored. */
export const MAX_RAW_TOOL_EVENTS_PER_RUN = 2000;

/** The kinds of event the raw cap applies to. */
export const RAW_CAPPED_TYPES: readonly LocalOnlyEvent["type"][] = ["tool_use", "file_changed"];

type Activity = NonNullable<ReturnType<typeof activityFor>>;

/** Tool names an older runner (no `activity` field) sends, and the kind each stands for. Anything else (Edit, Write, ...) makes no activity row. */
const LEGACY_TOOLS: Readonly<Record<string, Activity["tool"]>> = { Read: "read", Glob: "list", LS: "list", Grep: "search", Bash: "command" };

/** The stored form of one `tool_use` event, or null when it has none. */
export function activityOfEvent(event: LocalOnlyEvent): Activity | null {
  if (event.type !== "tool_use") return null;
  const a = event.activity;
  if (a !== undefined) return activityFor({ id: "", tool: a.tool, ...(a.path === undefined ? {} : { path: a.path }), ...(a.pattern === undefined ? {} : { pattern: a.pattern }), ...(a.command === undefined ? {} : { command: a.command }) });
  const tool = event.tool_name !== undefined && Object.hasOwn(LEGACY_TOOLS, event.tool_name) ? LEGACY_TOOLS[event.tool_name] : undefined;
  if (tool === undefined) return null;
  return activityFor({ id: "", tool, ...(tool === "command" || tool === "search" || event.file_path === undefined ? {} : { path: event.file_path }) });
}

/**
 * The event as the raw `runner.event` row should hold it: an `activity` is replaced by its reduced form, the one the derived row gets, so
 * a command that fails the clean check keeps its tool kind only and a path or term that fails the safe checks is dropped. The server does
 * not rely on the runner's own redaction for these three fields.
 */
export function eventForStorage(clean: LocalOnlyEvent): LocalOnlyEvent {
  if (clean.type !== "tool_use" || clean.activity === undefined) return clean;
  const { activity: _unreduced, ...rest } = clean;
  const reduced = activityOfEvent(clean);
  return reduced === null ? rest : { ...rest, activity: reduced };
}

/** The stages a runner event can become. The two dependency outcomes (D#6 C44-4) are stored as they are; the cloud sandbox recorder widens `RunStage` the same way. */
type ProjectedStage = RunStage | "deps_installed" | "deps_install_failed";

interface Row {
  seq: number;
  activity?: Activity;
  stage?: ProjectedStage;
}

/**
 * Rows for `stored` (events of one batch, in order): one per stage not yet recorded, and the newest activity of each 250 ms window
 * (the window starts at its first event), up to the run's 200-row cap. Coalescing looks at the batch only: a window cut by a batch
 * boundary can leave one extra row.
 */
export async function projectRunnerProgress(client: PoolClient, input: { accountId: string; runId: string; stored: readonly LocalOnlyEvent[] }): Promise<void> {
  const rows: Row[] = [];
  let window: { anchor: number; row: Row } | null = null;
  const stages = new Set<ProjectedStage>();
  for (const event of input.stored) {
    if (event.type === "stage" && event.stage !== undefined) {
      const stage: ProjectedStage = event.stage === "workspace_ready" ? "sandbox_ready" : event.stage;
      if (!stages.has(stage)) {
        stages.add(stage);
        rows.push({ seq: event.seq, stage });
      }
      continue;
    }
    const activity = activityOfEvent(event);
    if (activity === null) continue;
    const at = Date.parse(event.ts);
    if (window !== null && Math.abs(at - window.anchor) < RUN_PROGRESS_LIMITS.minActivityGapMs) {
      window.row.activity = activity;
      window.row.seq = event.seq;
    } else {
      const row: Row = { seq: event.seq, activity };
      window = { anchor: at, row };
      rows.push(row);
    }
  }
  if (rows.length === 0) return;
  const seen = await client.query<{ activity: number; stages: string[] | null }>(
    `SELECT (count(*) FILTER (WHERE kind = 'agent.activity'))::int AS activity,
            array_agg(DISTINCT payload->>'stage') FILTER (WHERE kind = 'run.stage') AS stages
       FROM run_events WHERE run_id = $1 AND account_id = $2 AND kind IN ('agent.activity', 'run.stage')`,
    [input.runId, input.accountId],
  );
  let activityRows = seen.rows[0]!.activity;
  const storedStages = new Set(seen.rows[0]!.stages ?? []);
  for (const row of rows.sort((a, b) => a.seq - b.seq)) {
    if (row.stage !== undefined) {
      if (!storedStages.has(row.stage)) await recordRunStageOn(client, { accountId: input.accountId, runId: input.runId, stage: row.stage });
    } else if (row.activity !== undefined && activityRows < RUN_PROGRESS_LIMITS.maxActivityRows) {
      await recordAgentActivityOn(client, { accountId: input.accountId, runId: input.runId, ...row.activity });
      activityRows++;
    }
  }
}

/**
 * The run has ended (a `run_ended` event or `done`): when the cap held activity back, leaves the one `agent.activity.capped` row, once.
 * `dropped` counts the activity-bearing tool uses that did not become a row (over the cap, or folded into a newer one in their window).
 * It reads stored raw rows, so tool uses past the 2,000-row raw cap are not in it: past that point it undercounts.
 * The caller holds the run row's lock, so two endings cannot both write it.
 */
export async function noteRunnerActivityCap(client: PoolClient, input: { accountId: string; runId: string }): Promise<void> {
  const { rows } = await client.query<{ shown: number; capped: boolean; bearing: number }>(
    `SELECT (count(*) FILTER (WHERE kind = 'agent.activity'))::int AS shown,
            bool_or(kind = 'agent.activity.capped') AS capped,
            (count(*) FILTER (WHERE kind = 'runner.event' AND payload->>'type' = 'tool_use'
                                AND (payload ? 'activity' OR payload->>'tool_name' IN ('Read', 'Glob', 'LS', 'Grep', 'Bash'))))::int AS bearing
       FROM run_events WHERE run_id = $1 AND account_id = $2 AND kind IN ('agent.activity', 'agent.activity.capped', 'runner.event')`,
    [input.runId, input.accountId],
  );
  const r = rows[0]!;
  if (r.capped || r.shown < RUN_PROGRESS_LIMITS.maxActivityRows || r.bearing <= r.shown) return;
  await recordAgentActivityCappedOn(client, { accountId: input.accountId, runId: input.runId, dropped: r.bearing - r.shown });
}
