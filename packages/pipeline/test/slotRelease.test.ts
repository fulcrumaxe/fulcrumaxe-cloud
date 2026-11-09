import { describe, expect, it } from "vitest";
import { SLOT_RELEASE_STAGES, SLOT_RELEASING_STOP_CODES, holdsSlotSql, isPersonOnlyStop, slotReleasedSql } from "@fx/core/src/work-items/slotRelease.js";
import { STOP_WORDS } from "@fx/core/src/work-items/stalled.js";
import { BUILD_SLOT_STAGES } from "../src/advance/buildSlots.js";

describe("slot release (a stopped pull request holds no build slot)", () => {
  it("releases only at slot stages, and never at in_progress (a live build)", () => {
    for (const s of SLOT_RELEASE_STAGES) expect(BUILD_SLOT_STAGES).toContain(s);
    expect(SLOT_RELEASE_STAGES).not.toContain("in_progress");
  });

  it("every releasing stop code has a sentence on the stalled card", () => {
    for (const c of SLOT_RELEASING_STOP_CODES) expect(Object.keys(STOP_WORDS), c).toContain(c);
  });

  it("the reviewer-environment sentence says the slot is given up and what restarts the item", () => {
    expect(STOP_WORDS.reviewer_environment).toMatch(/gives up its build slot/);
    expect(STOP_WORDS.reviewer_environment).toMatch(/continue the review/);
  });

  it("the SQL takes no parameters of its own and names the alias throughout", () => {
    const sql = slotReleasedSql("h");
    expect(sql).not.toMatch(/\$\d/);
    expect(holdsSlotSql("h", "$3::text[]")).toContain("h.stage = ANY($3::text[])");
    expect(sql).toContain("x.work_item_id = h.id");
  });
});

describe("the releasing stop codes", () => {
  it("are exactly the codes that end in Needs a person, plus the not_started_ prefix", () => {
    expect([...SLOT_RELEASING_STOP_CODES]).toEqual(["reviewer_environment", "review_quiet_period_unsettled", "review_key_missing"]);
    expect(isPersonOnlyStop("stopped", "not_started_no_model")).toBe(true);
    expect(isPersonOnlyStop("escalated", "reviewer_fail")).toBe(true);
    for (const c of ["review", "reviewer_not_started", "merge_gate", "build_wait_timeout"]) expect(isPersonOnlyStop("stopped", c), c).toBe(false);
    expect(isPersonOnlyStop("stopped", null)).toBe(false);
    expect(isPersonOnlyStop("review_started", "reviewer_environment")).toBe(false);
  });
});
