import { describe, expect, it } from "vitest";
import { startDeltaRoles, type DeltaReviewPorts, type DeltaRunRef, type MergeQueueEntry } from "../../src/mergeQueue/index.js";
import type { DeltaReviewInput } from "../../src/review/reviewPrompts.js";

/**
 * D#519 MQ3-b-2b: how the delta review's roles are started. Restarting after a cancelled or refused run needs the next attempt (the run key
 * is `delta:<sha>:<role>:s<n>`, and the old key still names the dead run); a role whose run is alive is reused, never started twice; a throw
 * halfway cancels what this call started and nothing else.
 */
const entry = { id: "e", accountId: "a", repoId: "r", prNumber: 7 } as MergeQueueEntry;
const delta: DeltaReviewInput = { mergeCommitSha: "b".repeat(40), parents: ["a".repeat(40), "c".repeat(40)], parentRoles: ["pr_side", "main_side"], changedFiles: ["src/a.ts"], trigger: "refresh_overlap" };

function ports(existing: DeltaRunRef[], over: Partial<DeltaReviewPorts> = {}) {
  const calls = { started: [] as Array<{ role: string; attempt: number }>, cancelled: [] as string[] };
  let n = 0;
  const p = {
    runs: async () => existing,
    startRole: async ({ role, attempt }: { role: string; attempt: number }) => {
      calls.started.push({ role, attempt });
      return { ok: true as const, runId: `run-${++n}` };
    },
    cancelRun: async (_e: MergeQueueEntry, id: string) => void calls.cancelled.push(id),
    ...over,
  } as unknown as DeltaReviewPorts;
  return { p, calls };
}

describe("startDeltaRoles", () => {
  it("a first start uses attempt 0 for every role", async () => {
    const { p, calls } = ports([]);
    expect(await startDeltaRoles(p, entry, delta, ["code-reviewer", "acceptance-tester"])).toEqual({ ok: true, runIds: ["run-1", "run-2"] });
    expect(calls.started).toEqual([{ role: "code-reviewer", attempt: 0 }, { role: "acceptance-tester", attempt: 0 }]);
  });

  it("a restart after a spend-refusal cancel starts the cancelled role under the next attempt", async () => {
    const { p, calls } = ports([{ role: "code-reviewer", runId: "old", attempt: 0, reusable: false }, { role: "acceptance-tester", runId: "old2", attempt: 2, reusable: false }]);
    await startDeltaRoles(p, entry, delta, ["code-reviewer", "acceptance-tester"]);
    expect(calls.started).toEqual([{ role: "code-reviewer", attempt: 1 }, { role: "acceptance-tester", attempt: 3 }]);
  });

  it("a role whose run is alive is reused: a replayed start starts nothing twice", async () => {
    const { p, calls } = ports([{ role: "code-reviewer", runId: "live", attempt: 0, reusable: true }]);
    expect(await startDeltaRoles(p, entry, delta, ["code-reviewer", "acceptance-tester"])).toEqual({ ok: true, runIds: ["live", "run-1"] });
    expect(calls.started).toEqual([{ role: "acceptance-tester", attempt: 0 }]);
  });

  it("a refusal cancels the runs this call started, never a reused one, and says why", async () => {
    const { p, calls } = ports([{ role: "code-reviewer", runId: "live", attempt: 0, reusable: true }], {
      startRole: async ({ role }) => (role === "security-reviewer" ? { ok: false, reason: "refused_spend" } : { ok: true, runId: `new-${role}` }),
    });
    expect(await startDeltaRoles(p, entry, delta, ["code-reviewer", "acceptance-tester", "security-reviewer"])).toEqual({ ok: false, reason: "refused_spend" });
    expect(calls.cancelled).toEqual(["new-acceptance-tester"]);
  });

  it("an error thrown halfway cancels the runs already started and is rethrown", async () => {
    const { p, calls } = ports([], {
      startRole: async ({ role }) => {
        if (role === "acceptance-tester") throw new Error("worker down");
        return { ok: true, runId: `new-${role}` };
      },
    });
    await expect(startDeltaRoles(p, entry, delta, ["code-reviewer", "acceptance-tester"])).rejects.toThrow("worker down");
    expect(calls.cancelled).toEqual(["new-code-reviewer"]);
  });

  it("a cancel that itself fails does not hide the original error", async () => {
    const { p } = ports([], {
      startRole: async () => {
        throw new Error("original");
      },
      cancelRun: async () => {
        throw new Error("cancel failed");
      },
    });
    await expect(startDeltaRoles(p, entry, delta, ["code-reviewer"])).rejects.toThrow("original");
  });
});
