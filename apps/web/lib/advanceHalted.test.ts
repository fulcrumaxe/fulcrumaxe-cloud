import { describe, expect, it, vi } from "vitest";
import { recordRoundBody } from "./advanceReviewSteps";
import { startClassifyBody } from "./advanceSteps";
import { startLightSpecBody } from "./advanceLightSteps";

/** DP-C6: the halt answers reach the workflow as their own decision, and the epoch rides every start. */
const WHO = { accountId: "a", userId: "u", workItemId: "w", haltEpoch: 3 };

describe("the workflow's view of a halt", () => {
  it("a record-round refusal for a halt is the decision 'halted', so the workflow ends instead of treating it as a failed round", async () => {
    for (const reason of ["item_halted", "halted_since_approval"]) {
      const worker = { advanceRecordRound: vi.fn(async () => ({ decision: "refused" as const, reason })) };
      expect(await recordRoundBody(worker as never, WHO, { headSha: "h", prNumber: 1, requiredRoles: [], verdicts: [] })).toMatchObject({ decision: "halted" });
    }
    const other = { advanceRecordRound: vi.fn(async () => ({ decision: "refused" as const, reason: "invalid_input" })) };
    expect(await recordRoundBody(other as never, WHO, { headSha: "h", prNumber: 1, requiredRoles: [], verdicts: [] })).toMatchObject({ decision: "refused" });
  });

  it("the classify and light-spec starts carry the epoch the workflow started under", async () => {
    const start = vi.fn(async (_req: unknown) => ({ ok: true as const, runId: "r" }));
    await startClassifyBody({ advanceStartRun: start } as never, "a", "w", 3, "act", { ok: true, mode: "triage", repoId: "r", owner: "o", name: "n", number: 1, login: "l", title: "t", body: "b", decided: null, because: null, hints: [] } as never);
    expect(start.mock.calls[0]![0]).toMatchObject({ haltEpoch: 3 });
    await startLightSpecBody({ advanceStartRun: start } as never, WHO, { category: "small", title: "t", body: "b" }, "act");
    expect(start.mock.calls[1]![0]).toMatchObject({ haltEpoch: 3 });
  });
});
