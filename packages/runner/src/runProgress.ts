import type { Pool } from "pg";
import { reportError } from "@fx/telemetry";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { safeRepoPath, safeSearchTerm } from "@fx/core/src/onboarding/previewProgress.js";
import { redactText } from "@fx/runtime/src/redact.js";
import { TOOL_ACTIVITY_LIMITS, commandIsClean, type ToolUse } from "@fx/runtime/src/toolActivity.js";
import type { NormalizedEvent } from "./types.js";
import type { Timers } from "./agentOutput.js";
import { recordAgentActivity, recordAgentActivityCapped, recordRunStage } from "./runStatusWriter.js";

/**
 * D#2 PREVIEW-RUNNER-EVENTS: what a run's tool use and launch become in `run_events`, for the preview's live progress view.
 *
 * Two kinds of row, both through the same tenant-scoped, redacting writer every other run event uses:
 *   - `run.stage`      { stage: 'sandbox_ready' | 'cloned' | 'writing_result' }, at most once each per run;
 *   - `agent.activity` { tool: 'read' | 'list' | 'search' | 'test' | 'command', path?, pattern?, command? }.
 *
 * An activity row holds ONLY a coarse kind plus a repo-relative path or a short search term, and a value that does not
 * pass the same checks the read side applies (previewProgress.ts) is dropped here, so nothing unsafe is stored in the
 * first place. File contents, command output, model text, URLs and env values never get this far: the stream
 * normalizer reduces a tool-use block before it becomes an event (see `@fx/runtime`'s toolActivity.ts). The one piece
 * of a shell command that is stored is its first line, and only when `safeCommandLine` accepts it.
 *
 * Limits (the table is insert-only for the runner, so a stored row cannot be folded afterwards):
 *   - rate: a burst inside `minActivityGapMs` collapses to its newest event (older ones are coalesced away);
 *   - cap: at most `maxActivityRows` rows per run; later ones are counted, and one `agent.activity.capped` row says how many.
 * A write is never awaited by the stream: the queue is bounded and a full one drops (and counts) the event.
 */
export const RUN_PROGRESS_LIMITS = {
  maxActivityRows: 200,
  /** At most one activity row per this many ms; a burst keeps its newest event. */
  minActivityGapMs: 250,
  /** Writes queued behind a slow database before further events are dropped and counted. */
  maxQueued: 32,
  /** Tool-use ids of clone commands awaiting their result. */
  maxPendingClones: 64,
  /** How long finish waits for the queue to flush. */
  flushTimeoutMs: 2000,
} as const;

export type RunStage = "sandbox_ready" | "cloned" | "writing_result";

export interface ProgressClock extends Timers {
  now(): number;
}

const realClock: ProgressClock = {
  now: () => Date.now(),
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (t) => clearTimeout(t as NodeJS.Timeout),
};

interface Activity {
  tool: "read" | "list" | "search" | "test" | "command";
  path?: string;
  pattern?: string;
  /** A shell command's first line; present only when `safeCommandLine` accepted it. */
  command?: string;
}

/** True when redaction would change `value`: it carries a credential shape, so it is not a path or a search term. */
const hasSecretShape = (value: string): boolean => redactText(value, []) !== value;

/**
 * A shell command's first line when it is safe to store and show, else null. The runtime already drops a command that
 * is not clean; this is the recorder's own check, so a value from any other source gets the same test: one short line
 * that redaction would not change (no token shape, no `NAME=secret` or `--password value` assignment), with no
 * credentialed URL and no redaction placeholder. Anything else keeps the kind alone, so the read side shows
 * "Running a command" and never a half-hidden line.
 */
export function safeCommandLine(command: string | undefined): string | null {
  if (command === undefined || command === "" || command.length > TOOL_ACTIVITY_LIMITS.maxCommandChars) return null;
  if (/[\u0000-\u001f\u007f]/.test(command)) return null;
  return commandIsClean(command) ? command : null;
}

/** A stored-form activity for one reduced tool use, or null when it must not be stored at all. Pure. */
export function activityFor(use: ToolUse): Activity | null {
  switch (use.tool) {
    case "read":
    case "list": {
      if (use.path === undefined) return use.tool === "list" ? { tool: "list" } : null;
      const path = safeRepoPath(use.path);
      return path !== null && !hasSecretShape(path) ? { tool: use.tool, path } : null;
    }
    case "search": {
      const pattern = use.pattern === undefined ? null : safeSearchTerm(use.pattern);
      return pattern !== null && !hasSecretShape(pattern) ? { tool: "search", pattern } : { tool: "search" };
    }
    case "test":
    case "command": {
      const command = safeCommandLine(use.command);
      return command !== null ? { tool: use.tool, command } : { tool: use.tool };
    }
    default:
      return null;
  }
}

/**
 * One run's progress writer. Never throws and never makes the stream wait. Its counters are seeded from the database on
 * the first write (one bounded query), so a run resumed on another instance continues from what is stored.
 */
export class RunProgressRecorder {
  private chain: Promise<void> = Promise.resolve();
  private queued = 0;
  private seeded = false;
  private rows = 0;
  private storedStages = new Set<RunStage>();
  private requestedStages = new Set<RunStage>();
  private pendingClones = new Set<string>();
  private pending: Activity | null = null;
  private lastWriteAt = Number.NEGATIVE_INFINITY;
  private timer: unknown;
  private done = false;
  private cappedWritten = false;
  coalesced = 0;
  overCap = 0;
  droppedFull = 0;
  failedWrites = 0;

  constructor(
    private readonly pool: Pool,
    private readonly accountId: string,
    private readonly runId: string,
    /** Test seam: the clock and the timers. */
    private readonly clock: ProgressClock = realClock,
  ) {}

  /** Reads one stream event's reduced tool blocks. Synchronous; the writes run behind it. */
  observe(event: NormalizedEvent): void {
    if (this.done) return;
    try {
      if (event.writesResult) this.stage("writing_result");
      for (const use of event.toolUses ?? []) {
        if (use.clone && this.pendingClones.size < RUN_PROGRESS_LIMITS.maxPendingClones) this.pendingClones.add(use.id);
        if (use.writes) this.stage("writing_result");
        const activity = activityFor(use);
        if (activity) this.activity(activity);
      }
      for (const result of event.toolResults ?? []) {
        if (this.pendingClones.delete(result.id) && result.ok) this.stage("cloned");
      }
    } catch (err) {
      // Progress is best effort; only the first failure per run is reported, so a broken stream is one report, not one per event.
      if (++this.failedWrites === 1) reportError(err, { stage: "run.progress_observe" });
    }
  }

  /** Marks a stage once per run. */
  stage(stage: RunStage): void {
    if (this.done || this.requestedStages.has(stage)) return;
    this.requestedStages.add(stage);
    this.enqueue(() => this.writeStage(stage));
  }

  private activity(activity: Activity): void {
    if (this.pending !== null) this.coalesced += 1;
    this.pending = activity;
    const wait = this.lastWriteAt + RUN_PROGRESS_LIMITS.minActivityGapMs - this.clock.now();
    if (wait <= 0) return this.flushPending();
    if (this.timer === undefined) {
      this.timer = this.clock.set(() => {
        this.timer = undefined;
        this.flushPending();
      }, wait);
    }
  }

  private flushPending(): void {
    if (this.timer !== undefined) {
      this.clock.clear(this.timer);
      this.timer = undefined;
    }
    const activity = this.pending;
    if (activity === null) return;
    this.pending = null;
    this.lastWriteAt = this.clock.now();
    this.enqueue(() => this.writeActivity(activity), true);
  }

  private enqueue(write: () => Promise<void>, isActivity = false): void {
    if (this.queued >= RUN_PROGRESS_LIMITS.maxQueued) {
      this.droppedFull += 1;
      if (isActivity) this.overCap += 1;
      return;
    }
    this.queued += 1;
    this.chain = this.chain.then(write).finally(() => void (this.queued -= 1));
  }

  /** Resolves once every write accepted so far has run (or failed). For tests and for `finish`; never rejects. */
  idle(): Promise<void> {
    return this.chain.then(() => undefined);
  }

  /** Flushes the newest burst, waits (bounded) for the writes, then leaves the one capped row if the cap dropped events. Never throws. */
  async finish(): Promise<void> {
    if (this.done) return;
    this.flushPending();
    this.done = true;
    let timer: unknown;
    const timeout = new Promise<false>((resolve) => (timer = this.clock.set(() => resolve(false), RUN_PROGRESS_LIMITS.flushTimeoutMs)));
    try {
      if (!(await Promise.race([this.chain.then(() => true), timeout]))) return void console.warn("run progress: writes still pending at finalize");
    } finally {
      this.clock.clear(timer);
    }
    if (this.overCap === 0 || this.cappedWritten) return;
    this.cappedWritten = true;
    await recordAgentActivityCapped(this.pool, { accountId: this.accountId, runId: this.runId, dropped: this.overCap }).catch(() => this.fail());
  }

  private fail(): void {
    this.failedWrites += 1;
    console.warn("run progress: a run_events write failed");
  }

  private async seed(): Promise<void> {
    const { rows } = await withTenant(this.pool, this.accountId, (client) =>
      client.query<{ activity: number; stages: string[] | null }>(
        `SELECT (count(*) FILTER (WHERE kind = 'agent.activity'))::int AS activity,
                array_agg(DISTINCT payload->>'stage') FILTER (WHERE kind = 'run.stage') AS stages
           FROM run_events WHERE run_id = $1 AND kind IN ('agent.activity', 'run.stage')`,
        [this.runId],
      ),
    );
    this.rows = rows[0]!.activity;
    for (const s of rows[0]!.stages ?? []) this.storedStages.add(s as RunStage);
    this.seeded = true;
  }

  private async writeStage(stage: RunStage): Promise<void> {
    try {
      if (!this.seeded) await this.seed();
      if (this.storedStages.has(stage)) return;
      await recordRunStage(this.pool, { accountId: this.accountId, runId: this.runId, stage });
      this.storedStages.add(stage);
    } catch (err) {
      if (++this.failedWrites === 1) reportError(err, { stage: "run.progress_write" });
    }
  }

  private async writeActivity(activity: Activity): Promise<void> {
    try {
      if (!this.seeded) await this.seed();
      if (this.rows >= RUN_PROGRESS_LIMITS.maxActivityRows) {
        this.overCap += 1;
        return;
      }
      await recordAgentActivity(this.pool, { accountId: this.accountId, runId: this.runId, ...activity });
      this.rows += 1;
    } catch (err) {
      if (++this.failedWrites === 1) reportError(err, { stage: "run.progress_write" });
    }
  }
}
