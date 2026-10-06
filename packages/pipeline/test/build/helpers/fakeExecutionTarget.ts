import { randomUUID } from "node:crypto";
import type { AdmitResult, CancelResult, DispatchResult, ExecutionRun, ExecutionTarget, TerminalReport } from "@fx/runner";

/**
 * A minimal, self-contained `ExecutionTarget` fake for this package's own
 * tests -- this package tests its OWN orchestration code (the ownership
 * check, round counting, escalation, label mapping, dispatch call
 * shapes), not `SandboxTarget`'s sandbox-simulation behaviour, which
 * packages/runner's own test suite already covers exhaustively. Deep-
 * importing packages/runner's `test/helpers/sandboxTargetFakes.ts` across
 * a package boundary would couple this package's tests to another
 * package's test-only internals; this fake is built fresh instead, at a
 * fraction of the size.
 */
export interface RecordedCall {
  method: "admit" | "dispatch" | "cancel" | "resume" | "finalize";
  run: ExecutionRun;
  sessionId?: string;
  report?: TerminalReport;
}

export interface FakeExecutionTargetHandle {
  target: ExecutionTarget;
  calls: RecordedCall[];
  /** Overridable per-test: defaults to always admitting. */
  admitResult: AdmitResult;
}

/**
 * `queued: true` makes the fake behave like a runner target (D#6 C12 section 2.1): `dispatch` and `resume` answer
 * `{ queued: true }` instead of a hook token, and its runs are stamped `runner`.
 */
export function createFakeExecutionTarget(options: { queued?: boolean } = {}): FakeExecutionTargetHandle {
  const calls: RecordedCall[] = [];
  const admitResultBox: { admitResult: AdmitResult } = { admitResult: { admitted: true } };

  const target: ExecutionTarget = {
    runtime: options.queued ? "runner" : "production",
    async admit(run: ExecutionRun): Promise<AdmitResult> {
      calls.push({ method: "admit", run });
      return admitResultBox.admitResult;
    },
    async dispatch(run: ExecutionRun): Promise<DispatchResult> {
      calls.push({ method: "dispatch", run });
      return options.queued ? { queued: true } : { hookToken: `dispatch-${randomUUID()}` };
    },
    async cancel(run: ExecutionRun): Promise<CancelResult> {
      calls.push({ method: "cancel", run });
      return { settled_usd: 0, released_usd: 0 };
    },
    async resume(run: ExecutionRun, sessionId: string): Promise<DispatchResult> {
      calls.push({ method: "resume", run, sessionId });
      return options.queued ? { queued: true } : { hookToken: `resume-${randomUUID()}` };
    },
    async finalize(run: ExecutionRun, report: TerminalReport): Promise<CancelResult> {
      calls.push({ method: "finalize", run, report });
      return { settled_usd: 0, released_usd: 0 };
    },
  };

  return {
    target,
    calls,
    get admitResult() {
      return admitResultBox.admitResult;
    },
    set admitResult(value: AdmitResult) {
      admitResultBox.admitResult = value;
    },
  };
}
