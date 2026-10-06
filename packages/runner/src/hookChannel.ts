import type { HookResult } from "./executionTarget.js";

/**
 * D#2 H09b2 (C10's revised criterion 3, H09.7): the WAIT side of the hook
 * `SandboxTarget`'s `HookResumePort` (targets/sandboxTarget.ts) resumes.
 * `workflows/agentRun.ts`'s post-dispatch watchdog races this against a
 * sleep -- "wait on a hook raced against a watchdog sleep" (Consensus
 * Summary). Lives here, not in `targets/sandboxTarget.ts`, because
 * `workflows/agentRun.ts` may import neither that file nor any of the
 * sandbox-specific modules it wraps (test/importBoundary.test.ts) --
 * structurally identical to (never imported from) that file's own
 * `HookResumePort`, which is how a real Vercel Workflow deployment's
 * `createHook`/`resumeHook` pair (not wired in this PR -- see
 * workflows/agentRun.ts's own header) would satisfy both shapes without
 * either file depending on the other.
 */
export interface HookWaitPort {
  wait(hookToken: string): Promise<HookResult>;
}

/** Structurally identical to `targets/sandboxTarget.ts`'s `HookResumePort`
 * -- deliberately not imported from there (import-boundary rule). */
export interface HookResumeSink {
  resume(hookToken: string, result: HookResult): Promise<void>;
}

/**
 * An in-memory pairing of `HookResumeSink`/`HookWaitPort`, for tests and
 * for any composition root that has not wired a real Workflow hook yet.
 * Handles both orderings: `resume` arriving before `wait` (the report is
 * held until someone waits for it) and `wait` arriving first (the waiter
 * is held until `resume` delivers).
 */
export function createInMemoryHookChannel(): { resumeSink: HookResumeSink; waitPort: HookWaitPort } {
  const waiters = new Map<string, (result: HookResult) => void>();
  const delivered = new Map<string, HookResult>();

  return {
    resumeSink: {
      async resume(hookToken, result) {
        const waiter = waiters.get(hookToken);
        if (waiter) {
          waiters.delete(hookToken);
          waiter(result);
        } else {
          delivered.set(hookToken, result);
        }
      },
    },
    waitPort: {
      wait(hookToken) {
        const already = delivered.get(hookToken);
        if (already) {
          delivered.delete(hookToken);
          return Promise.resolve(already);
        }
        return new Promise((resolve) => waiters.set(hookToken, resolve));
      },
    },
  };
}
