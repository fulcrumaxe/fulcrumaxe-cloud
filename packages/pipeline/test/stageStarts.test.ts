import { describe, expect, it } from "vitest";
import { PanelSeatFailedError } from "../src/plan/sandboxPanelRunner.js";
import { createFollowedRunner } from "../src/advance/followedRunner.js";
import { attemptKey } from "../src/advance/attemptKeys.js";
import { RESERVATION_DENIAL_PAUSES, RESERVATION_PAUSE_REASONS, RESERVATION_PAUSE_SENTENCES } from "../src/advance/reservationPauses.js";
import { PARKED_STAGE_REGISTRY } from "../src/advance/stageRegistry.js";
import { START_SITES, START_SITE_STAGE, SpecWriterPausedError, pauseOnDenial, siteStep, specPmAttempt, stageKeyLikes } from "../src/advance/stageStarts.js";
import { STAGE_WORDS, STAGE_WORD_PHRASES, stageWords } from "../src/advance/stageWords.js";
import { WAITING_STAGES } from "../src/advance/waitingStages.js";
import type { AdvanceRunPorts, AdvanceRunStart } from "../src/advance/runPorts.js";
import { likeToRegex } from "./helpers/likeToRegex.js";

const ITEM = "11111111-2222-4333-8444-555555555555";
const APPROVAL = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER = "99999999-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const DISCUSSION = "d0d0d0d0-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("S5-k1c: the stage words are one table of the six approved phrases", () => {
  it("exactly the six approved phrases, nothing else, for the seven stages (a re-spec shares the Spec's)", () => {
    expect([...STAGE_WORD_PHRASES].sort()).toEqual(["waiting for a fix round", "waiting for a review", "waiting for the panel", "waiting to build", "waiting to check this item", "waiting to write the Spec"]);
    expect(Object.keys(STAGE_WORDS).sort()).toEqual([...WAITING_STAGES].sort());
    expect(stageWords("classify")).toBe("waiting to check this item");
    expect(stageWords("spec")).toBe("waiting to write the Spec");
    expect(stageWords("respec")).toBe(stageWords("spec"));
    expect(stageWords("review")).toBe("waiting for a review");
    expect(stageWords("fix_round")).toBe("waiting for a fix round");
    expect(stageWords("panel")).toBe("waiting for the panel");
    expect(stageWords("build")).toBe("waiting to build");
  });

  it("no phrase carries a raw code, a placeholder or a stage name with an underscore", () => {
    for (const p of STAGE_WORD_PHRASES) expect(p).not.toMatch(/undefined|null|\{|_/);
  });
});

describe("S5-k1c: the four start sites", () => {
  it("each site waits as a stage in the closed list; the short Spec and the Spec PM are both 'spec'", () => {
    expect([...START_SITES]).toEqual(["classify", "spec_pm", "light_spec", "respec"]);
    expect(START_SITE_STAGE).toEqual({ classify: "classify", spec_pm: "spec", light_spec: "spec", respec: "respec" });
    for (const s of START_SITES) expect(WAITING_STAGES).toContain(START_SITE_STAGE[s]);
  });

  it("S5k1b-10 for these sites: the first ask is the bare key, a later ask is :s<n>, and a key that already ends in :s<n> keeps one suffix", () => {
    expect(siteStep("classify", APPROVAL)).toBe(`classify:${APPROVAL}`);
    expect(siteStep("classify", APPROVAL, 0)).toBe(`classify:${APPROVAL}`);
    expect(siteStep("light_spec", APPROVAL, 3)).toBe(`light-spec:${APPROVAL}:s3`);
    expect(siteStep("respec", APPROVAL, 12)).toBe(`respec:${APPROVAL}:s12`);
    expect(attemptKey(siteStep("respec", APPROVAL, 2), 5)).toBe(`respec:${APPROVAL}:s5`);
    expect(specPmAttempt(APPROVAL)).toBe(APPROVAL);
    expect(specPmAttempt(APPROVAL, 4)).toBe(`${APPROVAL}:s4`);
  });

  it("the step name fits the worker's step pattern at the highest attempt", () => {
    for (const site of ["classify", "light_spec", "respec"] as const) expect(siteStep(site, APPROVAL, 100_000)).toMatch(/^[a-z0-9:_.-]{1,128}$/i);
    expect(`spec:${DISCUSSION}:g9:pm:${specPmAttempt(APPROVAL, 100_000)}`).toMatch(/^[a-z0-9:_.-]{1,128}$/i);
  });

  it("the key patterns match every key shape a start makes (bare and attempts) and nobody else's", () => {
    const classify = stageKeyLikes("classify", ITEM, APPROVAL).map(likeToRegex);
    for (const k of [`advance:${ITEM}:${siteStep("classify", APPROVAL)}`, `advance:${ITEM}:${siteStep("classify", APPROVAL, 4)}`]) expect(classify.some((r) => r.test(k)), k).toBe(true);
    for (const k of [`advance:${ITEM}:${siteStep("classify", OTHER)}`, `advance:${OTHER}:${siteStep("classify", APPROVAL)}`, `advance:${ITEM}:${siteStep("respec", APPROVAL)}`, `advance:${ITEM}:build:v1:${APPROVAL}`]) expect(classify.some((r) => r.test(k)), k).toBe(false);

    const respec = stageKeyLikes("respec", ITEM, APPROVAL).map(likeToRegex);
    for (const k of [`advance:${ITEM}:${siteStep("respec", APPROVAL)}`, `advance:${ITEM}:${siteStep("respec", APPROVAL, 2)}`]) expect(respec.some((r) => r.test(k)), k).toBe(true);
    for (const k of [`advance:${ITEM}:${siteStep("classify", APPROVAL)}`, `advance:${ITEM}:${siteStep("respec", OTHER)}`]) expect(respec.some((r) => r.test(k)), k).toBe(false);

    const spec = stageKeyLikes("spec", ITEM, APPROVAL).map(likeToRegex);
    const pm = `advance:${ITEM}:spec:${DISCUSSION}:pm:${APPROVAL}`;
    for (const k of [pm, `${pm}:s2`, `advance:${ITEM}:spec:${DISCUSSION}:g2:pm:${APPROVAL}:s7`, `advance:${ITEM}:${siteStep("light_spec", APPROVAL)}`, `advance:${ITEM}:${siteStep("light_spec", APPROVAL, 3)}`]) expect(spec.some((r) => r.test(k)), k).toBe(true);
    for (const k of [`advance:${ITEM}:spec:${DISCUSSION}:pm:${OTHER}`, `advance:${ITEM}:spec:${DISCUSSION}:pm`, `advance:${OTHER}:spec:${DISCUSSION}:pm:${APPROVAL}`, `advance:${ITEM}:panel:${DISCUSSION}:r1:cost-analyst`, `advance:${ITEM}:${siteStep("classify", APPROVAL)}`]) expect(spec.some((r) => r.test(k)), k).toBe(false);
  });

  it("an item id or approval with a LIKE character cannot widen a pattern", () => {
    for (const stage of ["classify", "spec", "respec"] as const) for (const p of stageKeyLikes(stage, "a%b_c", "x%")) expect(p).toContain("a\\%b\\_c");
  });
});

describe("S5-k1c: the registry entries", () => {
  const entries = ["classify", "spec", "respec"] as const;

  it("S5k1c-8: classify, spec and respec are registered, each parked at the positions the table lists, for every pause, as the project manager", () => {
    for (const stage of entries) {
      const e = PARKED_STAGE_REGISTRY[stage]!;
      expect(e).toBeDefined();
      expect(e.stage).toBe(stage);
      expect(e.role).toBe("project-manager");
      expect([...e.pauses]).toEqual([...RESERVATION_PAUSE_REASONS]);
    }
    expect([...PARKED_STAGE_REGISTRY.classify!.itemStages]).toEqual(["triaged"]);
    expect([...PARKED_STAGE_REGISTRY.spec!.itemStages].sort()).toEqual(["discussing", "triaged"]);
    expect([...PARKED_STAGE_REGISTRY.respec!.itemStages].sort()).toEqual(["needs_human", "spec_ready"]);
  });

  it("which approval each restart runs under: classify and the re-spec on the item's own, the first Spec also on the card it replaced; only Spec-based stages need a Spec", () => {
    expect(PARKED_STAGE_REGISTRY.classify).toMatchObject({ approval: { kind: "advance_work_item", from: "self" }, needsSpec: false, respec: false });
    expect(PARKED_STAGE_REGISTRY.spec).toMatchObject({ approval: { kind: "advance_work_item", from: "origin" }, needsSpec: false, respec: false });
    expect(PARKED_STAGE_REGISTRY.respec).toMatchObject({ approval: { kind: "respec_work_item", from: "self" }, needsSpec: true, respec: true });
    expect(PARKED_STAGE_REGISTRY.build).toMatchObject({ approval: { kind: "advance_work_item", from: "self" }, needsSpec: true, respec: false });
  });

  it("nextAttempt is one above the highest across every key of the stage, and 0 with none", () => {
    for (const stage of entries) {
      const e = PARKED_STAGE_REGISTRY[stage]!;
      expect(e.nextAttempt([])).toBe(0);
      expect(e.nextAttempt([`x:${APPROVAL}`])).toBe(1);
      expect(e.nextAttempt([`x:${APPROVAL}`, `x:${APPROVAL}:s1`, `y:${APPROVAL}:s6`, `x:${APPROVAL}:s2`])).toBe(7);
    }
  });

  it("every entry maps a denial the way the start does, and a non-pause denial is null", () => {
    for (const stage of entries) {
      const e = PARKED_STAGE_REGISTRY[stage]!;
      for (const [denial, pause] of Object.entries(RESERVATION_DENIAL_PAUSES)) expect(e.pauseForDenial(denial)).toBe(pause);
      expect(e.pauseForDenial("account_not_active")).toBeNull();
    }
  });
});

describe("S5-k1c: a spend denial is a named pause; every other refusal keeps its shape", () => {
  it.each(Object.entries(RESERVATION_DENIAL_PAUSES))("%s becomes %s, with its sentence", (denial, pause) => {
    expect(pauseOnDenial({ ok: false, reason: denial })).toEqual({ ok: false, reason: pause });
    expect(RESERVATION_PAUSE_SENTENCES[pause]).toMatch(/[A-Za-z]/);
  });

  it("S5k1c-6: account_not_active, a missing model and every other refusal come back exactly as they came", () => {
    for (const reason of ["account_not_active", "no_model", "item_halted", "halted_since_approval", "already_running", "start_account_not_active", "execution_mode_changed", "spec_changed", "no_spec", "worker_unavailable", "invalid_input"]) {
      const refusal = { ok: false as const, reason };
      expect(pauseOnDenial(refusal)).toBe(refusal);
    }
  });

  it("a start that worked comes back as it was", () => {
    const started = { ok: true as const, runId: "r1" };
    expect(pauseOnDenial(started)).toBe(started);
  });
});

describe("S5-k1c: the Spec PM's start under a limit (the keyed runner)", () => {
  const ports = (answer: AdvanceRunStart): AdvanceRunPorts => ({
    startRun: async () => answer,
    outcome: async () => ({ status: "running", done: false, envelope: null }),
    cancel: async () => undefined,
  });
  const signal = new AbortController().signal;

  it.each(Object.entries(RESERVATION_DENIAL_PAUSES))("the PM writer turns the denial %s into a typed pause, not a failed run", async (denial, pause) => {
    const { writer } = createFollowedRunner(ports({ ok: false, reason: denial }), { pollMs: 1 });
    const err = await writer.writeSpec({ workItemId: ITEM, discussionId: DISCUSSION, prompt: "p", idempotencyKey: "k" }, signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpecWriterPausedError);
    expect((err as SpecWriterPausedError).pause).toBe(pause);
  });

  it("S5k1c-6: a refusal that is not a pause is still a failed seat for the PM (the existing shape)", async () => {
    const { writer } = createFollowedRunner(ports({ ok: false, reason: "account_not_active" }), { pollMs: 1 });
    const err = await writer.writeSpec({ workItemId: ITEM, discussionId: DISCUSSION, prompt: "p", idempotencyKey: "k" }, signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PanelSeatFailedError);
    expect((err as PanelSeatFailedError).runStatus).toBe("refused:account_not_active");
  });

  it("a panel seat's denial is still absorbed as a seat failure here (the panel is another row's)", async () => {
    const { panel } = createFollowedRunner(ports({ ok: false, reason: "model_budget_exceeded" }), { pollMs: 1 });
    const err = await panel.runSeat({ workItemId: ITEM, discussionId: DISCUSSION, role: "security-expert", prompt: "p", idempotencyKey: "k", round: 1 } as never, signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PanelSeatFailedError);
    expect((err as PanelSeatFailedError).runStatus).toBe("refused:model_budget_exceeded");
  });
});
