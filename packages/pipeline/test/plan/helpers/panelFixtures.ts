import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { Pool, PoolClient } from "pg";
import type { PanelRunner, PanelSeatRequest, PanelSeatResult } from "../../../src/plan/panel.js";
import type { PanelRole } from "../../../src/plan/panelRoles.js";
import type { SpecWriter, SpecWriteRequest } from "../../../src/plan/spec.js";
import type { TriageClassifier } from "../../../src/plan/classifier.js";
import { runTriageStep } from "../../../src/plan/step.js";
import type { TriageDeps } from "../../../src/plan/triage.js";

/** A trusted author, as H07 sees one. */
export const OWNER = { login: "owner", repoPermission: "admin", allowlist: ["owner"] } as const;

export function fixtureClassifier(out = "feature"): TriageClassifier & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    complete: async (prompt: string) => {
      calls.push(prompt);
      return out;
    },
  };
}

/** Inserts an `agent_runs` row the way the run machinery would leave it. */
export async function seedRun(admin: PoolClient, accountId: string, workItemId: string | null, role: string): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status)
     VALUES ($1, $2, $3, $4, 'production', 'succeeded')`,
    [id, accountId, workItemId, role],
  );
  return id;
}

export interface SeatScript {
  /** Envelope the finished run returns. Default: a plain agreeing comment. */
  output?: (req: PanelSeatRequest) => unknown;
  /** The role written into `agent_runs`. Default: the requested role. */
  runRole?: string;
  /** Run belongs to this work item instead of the request's. */
  workItemId?: string | null;
  /** Use a run seeded elsewhere (e.g. another tenant's). */
  runId?: string;
  /** Never resolves until `release()`. */
  hang?: boolean;
  /** Rejects. */
  fail?: boolean;
  /** With `hang`: the run keeps going when its signal is aborted (a crashed workflow never aborts anything). */
  ignoreAbort?: boolean;
}

/**
 * A fixture `PanelRunner`. It honours the port's contract: the same
 * idempotency key returns the same finished run and envelope, so replaying
 * the step starts nothing new. No model is involved.
 */
export class FixtureRunner implements PanelRunner {
  readonly requests: PanelSeatRequest[] = [];
  private readonly finished = new Map<string, Promise<PanelSeatResult>>();
  private readonly releases: Array<() => void> = [];
  script: Partial<Record<`${PanelRole}` | `${PanelRole}:${1 | 2}`, SeatScript>> = {};
  /** Resolves once this many seats are in flight together (proves parallelism). */
  barrier: { size: number; arrived: number; open: () => void; opened: Promise<void> } | null = null;

  constructor(
    private readonly admin: PoolClient,
    private readonly accountId: string,
  ) {}

  private tail: Promise<unknown> = Promise.resolve();

  /** One admin query at a time: the admin connection is a single client. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }

  requireParallel(size: number): void {
    let open!: () => void;
    const opened = new Promise<void>((r) => (open = r));
    this.barrier = { size, arrived: 0, open, opened };
  }

  release(): void {
    for (const r of this.releases.splice(0)) r();
  }

  /** Keys whose signal was aborted while the seat was still running. */
  readonly aborted: string[] = [];
  /** How many runs were really started per idempotency key. */
  readonly started = new Map<string, number>();

  runSeat(req: PanelSeatRequest, signal: AbortSignal = new AbortController().signal): Promise<PanelSeatResult> {
    this.requests.push(req);
    this.currentSignal.set(req.idempotencyKey, signal);
    let run = this.finished.get(req.idempotencyKey);
    if (!run) {
      run = this.produce(req);
      this.finished.set(req.idempotencyKey, run);
      // A failed start is not remembered: a replay starts it again.
      run.catch(() => this.finished.delete(req.idempotencyKey));
    }
    return run;
  }

  private readonly currentSignal = new Map<string, AbortSignal>();

  private async produce(req: PanelSeatRequest): Promise<PanelSeatResult> {
    this.started.set(req.idempotencyKey, (this.started.get(req.idempotencyKey) ?? 0) + 1);
    const signal = this.currentSignal.get(req.idempotencyKey)!;
    const s: SeatScript = this.script[`${req.role}:${req.round}`] ?? this.script[req.role] ?? {};
    if (this.barrier) {
      this.barrier.arrived++;
      if (this.barrier.arrived >= this.barrier.size) this.barrier.open();
      await this.barrier.opened;
    }
    if (s.hang) {
      await new Promise<void>((resolve, reject) => {
        this.releases.push(resolve);
        if (s.ignoreAbort) return;
        signal.addEventListener(
          "abort",
          () => {
            this.aborted.push(req.idempotencyKey);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    }
    if (s.fail) throw new Error("runner exploded: secret-token-do-not-leak");
    const agentRunId = s.runId ?? (await this.serial(() => seedRun(this.admin, this.accountId, s.workItemId === undefined ? req.workItemId : s.workItemId, s.runRole ?? req.role)));
    const agentOutput = s.output ? s.output(req) : { comment: `${req.role} round ${req.round}: fine.`, stance: "agree" };
    return { agentRunId, agentOutput };
  }
}

/** Creates a discussing Feature (or, with `category`, Critical) work item through the real triage step. */
export async function discussingItem(
  pool: Pool,
  accountId: string,
  text: { title: string; body: string; category?: "critical" | "feature"; repoId?: string },
  sourceEventId: string = randomUUID(),
): Promise<{ workItemId: string; discussionId: string }> {
  const deps: TriageDeps = { pool, accountId, classifier: fixtureClassifier(text.category ?? "feature") };
  const out = await runTriageStep(deps, { mode: "new", event: { ...OWNER, body: text.body }, title: text.title, sourceEventId, ...(text.repoId === undefined ? {} : { repoId: text.repoId }) });
  if (out.status !== "triaged" || out.stage !== "discussing") throw new Error(`fixture did not reach discussing: ${JSON.stringify(out)}`);
  return { workItemId: out.workItemId, discussionId: out.discussionId };
}

/**
 * A fixture `SpecWriter` (the PM). Same contract as the runner: one run per
 * key. Every call is logged in `calls` so a test can prove when the PM was
 * started relative to the seats.
 */
export class FixtureWriter implements SpecWriter {
  readonly calls: SpecWriteRequest[] = [];
  private readonly finished = new Map<string, Promise<PanelSeatResult>>();
  /** What the PM "says". */
  output: (req: SpecWriteRequest) => unknown = () => ({
    summary: "**technical-architect**: agrees.\n**security-expert**: agrees.\n**cost-analyst**: agrees.",
    spec: "1. The thing works.\n2. The thing is tested.",
    acceptance_files: ["src/a.ts"],
  });
  failWith: Error | null = null;
  hang = false;

  constructor(
    private readonly admin: PoolClient,
    private readonly accountId: string,
  ) {}

  writeSpec(req: SpecWriteRequest, signal: AbortSignal = new AbortController().signal): Promise<PanelSeatResult> {
    this.calls.push(req);
    let run = this.finished.get(req.idempotencyKey);
    if (!run) {
      run = (async () => {
        if (this.failWith) throw this.failWith;
        if (this.hang) await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
        const agentRunId = await seedRun(this.admin, this.accountId, req.workItemId, "project-manager");
        return { agentRunId, agentOutput: this.output(req) };
      })();
      this.finished.set(req.idempotencyKey, run);
      run.catch(() => this.finished.delete(req.idempotencyKey));
    }
    return run;
  }
}

/**
 * D#483 P2: a seat or PM prompt carries exactly ONE genuine AGENT_OUTPUT block, the pipeline's own, and it is the last
 * thing in the prompt. Any marker in untrusted text was defanged by `sanitize`, so it cannot be counted as a second one.
 */
export function expectOneGenuineEnvelope(prompt: string): void {
  expect(prompt.match(/<!--\s*AGENT_OUTPUT\s*-->/g)).toHaveLength(1);
  expect(prompt.match(/<!--\s*\/AGENT_OUTPUT\s*-->/g)).toHaveLength(1);
  expect(prompt.trimEnd().endsWith("<!-- /AGENT_OUTPUT -->")).toBe(true);
}
