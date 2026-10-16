import { describe, expect, it, vi } from "vitest";
import { startClassifyBody, type TriageLoaded } from "./advanceSteps";
import { startLightSpecBody } from "./advanceLightSteps";
import { startRespecBody } from "./advanceRespecSteps";
import { specBody } from "./advanceStageSteps";

/**
 * D#483 S5-k1c: the three step-keyed starts before the build, at the step-body level: the attempt number is in the key, a spend denial comes out as its named
 * pause, and every other answer comes out as it went in. (The Spec PM's key is built inside the Spec step; its attempt travels as `spendAttempt`.)
 */
const WHO = { accountId: "a", userId: "u", workItemId: "w", haltEpoch: 3 };
const LOADED = { owner: "acme", name: "widgets", number: 7, title: "T", body: "B", hints: [] } as unknown as TriageLoaded;
const DENIALS: Array<[string, string]> = [
  ["model_budget_exceeded", "account_budget_reached"],
  ["compute_cap_exceeded", "compute_cap_reached"],
  ["work_item_cap_exceeded", "item_cap_reached"],
  ["per_spawn_cap_exceeded", "run_limit_below_estimate"],
  ["envelope_exceeded", "envelope_reached"],
];

const sites = [
  {
    name: "classify",
    prefix: "classify",
    run: (worker: unknown, attempt?: number) => startClassifyBody(worker as never, "a", "w", 3, "act-1", LOADED, attempt),
  },
  {
    name: "the short Spec",
    prefix: "light-spec",
    run: (worker: unknown, attempt?: number) => startLightSpecBody(worker as never, WHO, { category: "small", title: "T", body: "B" }, "act-1", attempt),
  },
  {
    name: "the re-spec",
    prefix: "respec",
    run: (worker: unknown, attempt?: number) => startRespecBody(worker as never, WHO, 2, "act-1", attempt),
  },
];

describe.each(sites)("$name start", (s) => {
  const worker = (answer: unknown) => ({ advanceStartRun: vi.fn(async (_req: unknown) => answer), advanceLoadSpecText: async () => ({ version: 2, body: "SPEC" }) });
  const stepOf = (w: ReturnType<typeof worker>) => (w.advanceStartRun.mock.calls[0]![0] as { step: string }).step;

  it("the first ask keeps the key it always had; a later ask carries its attempt number", async () => {
    const first = worker({ ok: true, runId: "r" });
    await s.run(first);
    expect(stepOf(first)).toBe(`${s.prefix}:act-1`);
    const zero = worker({ ok: true, runId: "r" });
    await s.run(zero, 0);
    expect(stepOf(zero)).toBe(`${s.prefix}:act-1`);
    const later = worker({ ok: true, runId: "r" });
    await s.run(later, 4);
    expect(stepOf(later)).toBe(`${s.prefix}:act-1:s4`);
  });

  it.each(DENIALS)("S5k1c-1: the denial %s comes out as the pause %s", async (denial, pause) => {
    expect(await s.run(worker({ ok: false, reason: denial }))).toEqual({ ok: false, reason: pause });
  });

  it("S5k1c-6: a start that worked, and every refusal that is not a spend denial, come out as they went in", async () => {
    expect(await s.run(worker({ ok: true, runId: "r9" }))).toEqual({ ok: true, runId: "r9" });
    for (const reason of ["account_not_active", "no_model", "item_halted", "halted_since_approval", "already_running", "execution_mode_changed"]) {
      expect(await s.run(worker({ ok: false, reason }))).toEqual({ ok: false, reason });
    }
  });
});

describe("the Spec step", () => {
  const worker = () => ({ advanceSpec: vi.fn(async (..._args: unknown[]) => ({ status: "refused", reason: "account_budget_reached" })) });

  it("the first ask is the call it always was; a later ask passes its attempt number", async () => {
    const w = worker();
    await specBody(w as never, WHO, "act-1");
    await specBody(w as never, WHO, "act-1", 0);
    await specBody(w as never, WHO, "act-1", 3);
    expect(w.advanceSpec.mock.calls).toEqual([
      [WHO, "act-1"],
      [WHO, "act-1"],
      [WHO, "act-1", 3],
    ]);
  });

  it("the pause the pipeline answered reaches the workflow as the refusal's reason", async () => {
    expect(await specBody(worker() as never, WHO, "act-1")).toMatchObject({ status: "refused", reason: "account_budget_reached" });
  });
});
