import { describe, expect, it } from "vitest";
import { outcomeOf } from "../../../src/engines/claude/engine.js";
import type { JobLimits } from "../../../src/sandbox/jobLimits.js";
import { RUN_ID, engineFor, makeRig } from "./rig.js";

/** Limits that start the program unchanged (the scope itself is proven against the real systemd in jobLimits.real.test.ts) and answer as told. */
function recording(exceeded: boolean): JobLimits & { wrapped: Array<{ runId: string; role: string; command: string }>; asked: string[] } {
  const wrapped: Array<{ runId: string; role: string; command: string }> = [];
  const asked: string[] = [];
  return {
    wrapped,
    asked,
    wrap(job, command, args, env) {
      wrapped.push({ ...job, command });
      return { command, args: [...args], env: { ...env, FX_TEST_WRAPPED: "yes" } };
    },
    async exceeded(runId) {
      asked.push(runId);
      return exceeded;
    },
  };
}

describe("per-job limits in the engine (D#6 C43-5)", () => {
  it("the agent is started through the limits, and its own environment is the one it would have had", async () => {
    const rig = makeRig();
    const limits = recording(false);
    rig.config.limits = limits;
    const { handle } = await engineFor(rig).start(rig.startOptions());
    expect((await outcomeOf(handle)).status).toBe("ok");
    expect(limits.wrapped).toEqual([{ runId: RUN_ID, role: "executor", command: rig.fake.binary }]);
    // The wrapper's extra variable reached the start; nothing of the job's own text did.
    expect(rig.fake.envText()).toContain("FX_TEST_WRAPPED=yes");
  });

  it("a clean end never asks the scope anything", async () => {
    const rig = makeRig();
    const limits = recording(true);
    rig.config.limits = limits;
    const { handle } = await engineFor(rig).start(rig.startOptions());
    expect((await outcomeOf(handle)).status).toBe("ok");
    expect(limits.asked).toEqual([]);
  });

  it("a job the kernel killed for its memory budget ends resource_limit, whatever else it printed", async () => {
    const rig = makeRig();
    rig.fake.set("exit-code", "137");
    const limits = recording(true);
    rig.config.limits = limits;
    const { handle } = await engineFor(rig).start(rig.startOptions());
    const outcome = await outcomeOf(handle);
    expect(outcome).toMatchObject({ status: "failed", failureReason: "resource_limit" });
    expect(limits.asked).toEqual([RUN_ID]);
  });

  it("a failed end the scope does not blame on the budget keeps its own reason (and a scope that cannot answer counts as no)", async () => {
    const rig = makeRig();
    rig.fake.set("exit-code", "137");
    rig.config.limits = recording(false);
    expect((await outcomeOf((await engineFor(rig).start(rig.startOptions())).handle)).failureReason).not.toBe("resource_limit");
    const failing: JobLimits = { ...recording(false), exceeded: async () => Promise.reject(new Error("no bus")) };
    const other = makeRig();
    other.fake.set("exit-code", "137");
    other.config.limits = failing;
    expect((await outcomeOf((await engineFor(other).start(other.startOptions())).handle)).failureReason).not.toBe("resource_limit");
  });

  it("without limits the start is exactly as before", async () => {
    const rig = makeRig();
    const { handle } = await engineFor(rig).start(rig.startOptions());
    expect((await outcomeOf(handle)).status).toBe("ok");
    expect(rig.fake.envText()).not.toContain("FX_TEST_WRAPPED");
  });
});
