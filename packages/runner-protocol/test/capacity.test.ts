import { describe, expect, it } from "vitest";
import { JOB_CLASS_BY_ROLE, LIGHT_JOB_ROLES, RUNNER_ELIGIBLE_ROLES } from "../src/job.js";
import { capacityFreeSlots, type ClaimCapacity } from "../src/messages.js";

describe("capacityFreeSlots (D#6 C43-2b)", () => {
  const cap = (light: [number, number], heavy: [number, number]): ClaimCapacity => ({ light: { limit: light[0], in_use: light[1] }, heavy: { limit: heavy[0], in_use: heavy[1] } });
  const none = { light: 0, heavy: 0 };
  it("is limit minus in_use per class, never below zero", () => {
    expect(capacityFreeSlots(cap([3, 1], [1, 0]), none)).toEqual({ light: 2, heavy: 1, total: 3 });
    expect(capacityFreeSlots(cap([1, 3], [1, 0]), none)).toEqual({ light: 0, heavy: 1, total: 1 });
    expect(capacityFreeSlots(cap([0, 0], [0, 0]), none)).toEqual({ light: 0, heavy: 0, total: 0 });
  });
  it("uses the larger of what the runner says it holds and what the cloud counts", () => {
    expect(capacityFreeSlots(cap([3, 0], [1, 0]), { light: 2, heavy: 0 })).toMatchObject({ light: 1 });
    expect(capacityFreeSlots(cap([3, 2], [1, 0]), none)).toMatchObject({ light: 1 });
  });
  it("holds a runner to light 8, heavy 4 and a total of 8", () => {
    expect(capacityFreeSlots(cap([8, 0], [4, 0]), none)).toEqual({ light: 8, heavy: 4, total: 8 });
    expect(capacityFreeSlots(cap([8, 5], [4, 0]), none)).toEqual({ light: 3, heavy: 3, total: 3 });
    // A limit above a ceiling (the schema refuses one; the helper still bounds it).
    expect(capacityFreeSlots(cap([20, 0], [9, 0]), none)).toEqual({ light: 8, heavy: 4, total: 8 });
  });
  it("the light roles are exactly the runner-eligible roles that are not heavy", () => {
    expect([...LIGHT_JOB_ROLES].sort()).toEqual(RUNNER_ELIGIBLE_ROLES.filter((r) => JOB_CLASS_BY_ROLE[r] === "light").sort());
    expect(LIGHT_JOB_ROLES).not.toContain("executor");
    expect(LIGHT_JOB_ROLES).not.toContain("acceptance-tester");
  });
});
