import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isAdmitDenyReason } from "@fx/runner";
import {
  RESERVATION_DENIAL_PAUSES,
  RESERVATION_PAUSE_REASONS,
  RESERVATION_PAUSE_SENTENCES,
  RESERVATION_ORPHAN_AFTER_SECONDS,
  RESERVATION_PAUSE_WINDOW_SECONDS,
  RESERVATION_POLL_SECONDS,
  RESERVATION_SWEEP_SECONDS,
  isReservationPause,
  pauseForDenial,
  envelopeReachedSentence,
} from "../src/advance/reservationPauses.js";
import { BUILD_WAIT_REASONS } from "../src/advance/buildSlots.js";

/** D#483 S5-k1: the pure half of the named pauses, and the lists other packages repeat. */
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, rel), "utf8");

describe("the four denials and their names", () => {
  it("each denial that exists today becomes its own named pause", () => {
    expect(pauseForDenial("model_budget_exceeded")).toBe("account_budget_reached");
    expect(pauseForDenial("compute_cap_exceeded")).toBe("compute_cap_reached");
    expect(pauseForDenial("work_item_cap_exceeded")).toBe("item_cap_reached");
    expect(pauseForDenial("per_spawn_cap_exceeded")).toBe("run_limit_below_estimate");
    expect(pauseForDenial("envelope_exceeded")).toBe("envelope_reached");
  });

  it("every denial named here is one the runner's closed refusal set really carries (a renamed denial fails here, not in production)", () => {
    for (const denial of Object.keys(RESERVATION_DENIAL_PAUSES)) expect(isAdmitDenyReason(denial)).toBe(true);
  });

  it("account_not_active and every other refusal are not pauses", () => {
    for (const other of ["account_not_active", "model_connection_not_ok", "unknown_model", "runner_daily_limit", "public_repo", "item_halted", "start_no_model", "", null, undefined, 4, {}, "toString", "__proto__"]) {
      expect(pauseForDenial(other)).toBeNull();
    }
    for (const slot of BUILD_WAIT_REASONS) expect(isReservationPause(slot)).toBe(false);
  });

  it("the pause names do not collide with the slot wait names (one fact kind carries both)", () => {
    for (const p of RESERVATION_PAUSE_REASONS) expect((BUILD_WAIT_REASONS as readonly string[]).includes(p)).toBe(false);
    expect(new Set(RESERVATION_PAUSE_REASONS).size).toBe(5);
  });
});

describe("the sentences", () => {
  it("every pause has one plain sentence, with no raw code, no placeholder and no 'undefined' in it", () => {
    for (const p of RESERVATION_PAUSE_REASONS) {
      const s = RESERVATION_PAUSE_SENTENCES[p];
      expect(s.length).toBeGreaterThan(20);
      expect(s).toMatch(/[.]$/);
      expect(s).not.toMatch(/undefined|null|\{|_exceeded|_reached|_estimate/);
    }
    expect(Object.keys(RESERVATION_PAUSE_SENTENCES).sort()).toEqual([...RESERVATION_PAUSE_REASONS].sort());
  });

  it("the two limits a person sets in Roles > Limits say where to raise them", () => {
    expect(RESERVATION_PAUSE_SENTENCES.item_cap_reached).toBe("This item reached its spending cap. Raise it in Roles > Limits.");
    expect(RESERVATION_PAUSE_SENTENCES.run_limit_below_estimate).toBe("This step needs more than the per-run limit in Roles > Limits.");
  });
});

describe("the lists and numbers the workflow and the worker repeat", () => {
  const listIn = (src: string): string[] => {
    const m = /RESERVATION_PAUSE_REASONS: readonly string\[\] = \[([^\]]*)\]/.exec(src);
    expect(m).not.toBeNull();
    return [...m![1]!.matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]!);
  };

  it("the workflow and the worker repeat the pause names, equal to this module's", () => {
    expect(listIn(read("../../../apps/web/workflows/workItemAdvance.ts"))).toEqual([...RESERVATION_PAUSE_REASONS]);
    expect(listIn(read("../../worker/src/advance.ts"))).toEqual([...RESERVATION_PAUSE_REASONS]);
  });

  it("the workflow asks again every RESERVATION_POLL_SECONDS", () => {
    const m = /BUILD_SPEND_POLL_MS = ([0-9_]+);/.exec(read("../../../apps/web/workflows/workItemAdvance.ts"));
    expect(Number(m![1]!.replaceAll("_", "")) / 1000).toBe(RESERVATION_POLL_SECONDS);
  });

  it("D#483 S5-k1b: the sweep runs every 15 minutes, a pause counts for three passes (45 minutes), and a fact two asks old has no live workflow behind it", () => {
    const cfg = JSON.parse(read("../../../apps/web/vercel.json")) as { crons: Array<{ path: string; schedule: string }> };
    expect(cfg.crons.filter((c) => c.path === "/api/cron/stage-resume-sweep")).toEqual([{ path: "/api/cron/stage-resume-sweep", schedule: "*/15 * * * *" }]);
    expect(RESERVATION_SWEEP_SECONDS).toBe(15 * 60);
    expect(RESERVATION_PAUSE_WINDOW_SECONDS).toBe(45 * 60);
    expect(RESERVATION_ORPHAN_AFTER_SECONDS).toBe(2 * RESERVATION_POLL_SECONDS);
    // The worker repeats the two numbers (it cannot import this package).
    const w = read("../../worker/src/stageResume.ts");
    expect(Number(/STAGE_RESUME_PASS_SECONDS = (\d+)/.exec(w)![1])).toBe(RESERVATION_SWEEP_SECONDS);
    expect(Number(/STAGE_RESUME_ORPHAN_AFTER_SECONDS = (\d+)/.exec(w)![1])).toBe(RESERVATION_ORPHAN_AFTER_SECONDS);
  });

  it("the pause code fits what a driver fact accepts", () => {
    for (const p of RESERVATION_PAUSE_REASONS) expect(p).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
  });
});

describe("S5-d: the envelope sentence", () => {
  it("carries the person's own figure, to the cent, and never a raw number format", () => {
    expect(envelopeReachedSentence(0.5)).toBe("Paused: this item reached its $0.50 limit. Raise the limit to continue, or stop the item.");
    expect(envelopeReachedSentence(0.7)).toContain("$0.70 limit");
  });
  it("falls back to the figureless sentence for a bad amount (no NaN or undefined on screen)", () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(envelopeReachedSentence(bad)).toBe(RESERVATION_PAUSE_SENTENCES.envelope_reached);
    }
    expect(envelopeReachedSentence(Number.NaN)).not.toMatch(/NaN|undefined|null/);
  });
});
