import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WAITING_STAGES as CORE_WAITING_STAGES } from "@fx/core/src/work-items/driverEvents.js";
import { PANEL_PROGRESS_KINDS, PANEL_WHOLE_CODE, PARKED_STAGE_REGISTRY, UNREGISTERED_STAGES, registeredStages } from "../src/advance/stageRegistry.js";
import { WAITING_STAGES, WAITING_STAGE_POSITIONS, isWaitingStage, stageOfFact } from "../src/advance/waitingStages.js";
import { RESERVATION_PAUSE_REASONS } from "../src/advance/reservationPauses.js";
import { attemptOfKey } from "../src/advance/attemptKeys.js";
import { likeToRegex } from "./helpers/likeToRegex.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, rel), "utf8");

/** D#483 S5k1b-11 and -13: no waiting stage is left out of the sweep by accident, and nothing writes the old fact. */
describe("the parked-stage registry", () => {
  it("every waiting stage has a registry entry or a line in the unregistered list, and never both", () => {
    for (const stage of WAITING_STAGES) {
      const registered = PARKED_STAGE_REGISTRY[stage] !== undefined;
      const listed = UNREGISTERED_STAGES.includes(stage);
      expect(registered !== listed, `${stage}: registered=${registered}, unregistered=${listed}`).toBe(true);
    }
    for (const stage of UNREGISTERED_STAGES) expect(WAITING_STAGES).toContain(stage);
  });

  it("S5k1c-8 and S5k1d-8 held, and S5k1e-7: the panel was the last row to leave the allowlist, so it is empty and every stage has an entry", () => {
    expect(registeredStages().map((e) => e.stage)).toEqual(["build", "classify", "spec", "respec", "review", "fix_round", "panel"]);
    expect([...UNREGISTERED_STAGES]).toEqual([]);
    expect(UNREGISTERED_STAGES).toHaveLength(0);
    for (const stage of WAITING_STAGES) expect(PARKED_STAGE_REGISTRY[stage], stage).toBeDefined();
  });

  it("S5k1e: the panel lists the fact its workflow writes once the panel is whole again among its progress kinds, so a whole panel is not the sweep's to restart", () => {
    expect(PANEL_WHOLE_CODE).toBe("panel_whole");
    expect(PARKED_STAGE_REGISTRY.panel!.progressKinds).toContain("stopped");
    expect(PARKED_STAGE_REGISTRY.panel!.progressKinds).toBe(PANEL_PROGRESS_KINDS);
  });

  it("an entry is keyed by its own stage and parks only for a spend pause at stage positions the table lists", () => {
    for (const e of registeredStages()) {
      expect(PARKED_STAGE_REGISTRY[e.stage]).toBe(e);
      expect(e.pauses.length).toBeGreaterThan(0);
      for (const p of e.pauses) expect(RESERVATION_PAUSE_REASONS).toContain(p);
      for (const s of e.itemStages) expect(WAITING_STAGE_POSITIONS[e.stage]).toContain(s);
    }
  });

  it("the build entry: Spec ready only, and the run-key pattern matches its keys (bare, attempt, attempt with a note pin) and no one else's", () => {
    const e = PARKED_STAGE_REGISTRY.build!;
    expect(e.itemStages).toEqual(["spec_ready"]);
    const item = "11111111-2222-4333-8444-555555555555";
    const approval = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const likes = e.runKeyLikes(item, approval);
    expect(likes).toHaveLength(1);
    const re = likeToRegex(likes[0]!);
    for (const k of [`advance:${item}:build:v2:${approval}`, `advance:${item}:build:v2:${approval}:s3`, `advance:${item}:build:v2:${approval}:s3:n0123456789abcdef`]) expect(re.test(k), k).toBe(true);
    for (const k of [`advance:${item}:build:v2:other`, `advance:${item}:spec:v2:${approval}`, `advance:00000000-0000-4000-8000-000000000000:build:v2:${approval}`]) expect(re.test(k), k).toBe(false);
  });

  it("nextAttempt: 0 with no run, else one past the highest (never the bare key once a run holds it)", () => {
    const e = PARKED_STAGE_REGISTRY.build!;
    const b = "advance:i:build:v1:a";
    expect(e.nextAttempt([])).toBe(0);
    expect(e.nextAttempt([b])).toBe(1);
    expect(e.nextAttempt([b, `${b}:s1`, `${b}:s5:n0123456789abcdef`])).toBe(6);
    expect(attemptOfKey(`${b}:s5:n0123456789abcdef`)).toBe(5);
  });

  it("pauseForDenial is the start's own mapping, and a non-pause denial is null", () => {
    const e = PARKED_STAGE_REGISTRY.build!;
    expect(e.pauseForDenial("model_budget_exceeded")).toBe("account_budget_reached");
    expect(e.pauseForDenial("account_not_active")).toBeNull();
  });
});

describe("the waiting stages", () => {
  it("the list the pipeline and the driver-event store use is one list", () => {
    expect([...WAITING_STAGES]).toEqual([...CORE_WAITING_STAGES]);
  });

  it("migration 0845's check lists the same stages", () => {
    const dir = join(here, "../../db/migrations");
    const file = readdirSync(dir).find((f) => f.startsWith("0845_"))!;
    const sql = readFileSync(join(dir, file), "utf8");
    const m = /work_item_driver_events_stage_check CHECK \(stage IN \(([^)]*)\)\)/.exec(sql);
    expect(m).not.toBeNull();
    expect([...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1])).toEqual([...WAITING_STAGES]);
  });

  it("every stage has positions, and the fact's stage reads back (a build_waiting row with no stage is the build stage)", () => {
    for (const s of WAITING_STAGES) {
      expect(WAITING_STAGE_POSITIONS[s].length).toBeGreaterThan(0);
      expect(isWaitingStage(s)).toBe(true);
      expect(stageOfFact(s)).toBe(s);
    }
    expect(stageOfFact(null)).toBe("build");
    expect(stageOfFact("nonsense")).toBeNull();
  });
});

describe("D#483 S5k1b-13: nothing writes the older fact", () => {
  const writes = (src: string): string[] => [...src.matchAll(/kind:\s*["']build_waiting["']/g)].map((m) => m[0]);

  it("no source file (not a test) writes kind: build_waiting", () => {
    const roots = ["../../worker/src", "../../pipeline/src", "../../core/src", "../../../apps/web/lib", "../../../apps/web/workflows", "../../../apps/web/app"];
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? (d.name === "node_modules" ? [] : walk(join(dir, d.name))) : /\.tsx?$/.test(d.name) && !/\.test\.tsx?$/.test(d.name) ? [join(dir, d.name)] : []));
    const hits: string[] = [];
    for (const r of roots) for (const f of walk(join(here, r))) if (writes(readFileSync(f, "utf8")).length > 0) hits.push(f);
    expect(hits).toEqual([]);
  });

  it("the build site writes stage_waiting for the build stage", () => {
    expect(read("../../worker/src/advance.ts")).toMatch(/kind:\s*"stage_waiting",\s*stage:\s*"build"/);
  });
});
