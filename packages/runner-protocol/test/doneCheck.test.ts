import { describe, expect, it } from "vitest";
import { CHECK_JOB_MIN_PROTOCOL, CURRENT_PROTOCOL_VERSION, DETAILS_OF_RUN_ENDED, DoneCheck, LocalOnlyEvent, RUNNER_MESSAGES } from "../src/messages.js";

const RUN = "33333333-3333-4333-8333-333333333333";
const CHECK = { exit_code: 0, duration_ms: 41_000, timed_out: false, skipped_tests: 14, summary: "Tests  120 passed | 14 skipped (134)" };
const done = (extra: object) => RUNNER_MESSAGES.done.safeParse({ run_id: RUN, lease_generation: 1, ...extra });

describe("D#6 R-CHK-2: how the check ended, on done", () => {
  it("is optional, and a done without it is as before", () => {
    expect(done({}).success).toBe(true);
    expect(done({ check: CHECK }).success).toBe(true);
  });

  it("takes a null exit code (killed at the cap, or not run) and a null skipped count", () => {
    expect(DoneCheck.safeParse({ exit_code: null, duration_ms: 0, timed_out: false, skipped_tests: null, summary: "" }).success).toBe(true);
    expect(DoneCheck.safeParse({ ...CHECK, exit_code: null, timed_out: true }).success).toBe(true);
  });

  it("is strict and bounded: no extra key, no negative duration, no fractional count, a summary of at most 4096 characters", () => {
    for (const bad of [{ ...CHECK, extra: 1 }, { ...CHECK, duration_ms: -1 }, { ...CHECK, skipped_tests: 1.5 }, { ...CHECK, timed_out: "no" }, { ...CHECK, summary: "x".repeat(4097) }, { ...CHECK, exit_code: undefined }]) {
      expect(DoneCheck.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
    expect(DoneCheck.safeParse({ ...CHECK, summary: "x".repeat(4096) }).success).toBe(true);
  });

  it("is bounded to what the cloud can store: exit code within 1e6, duration within a week, skipped count within 1e8, a timed-out check without an exit code", () => {
    const ok = (over: object) => DoneCheck.safeParse({ ...CHECK, ...over }).success;
    expect(ok({ exit_code: 1_000_000 })).toBe(true);
    expect(ok({ exit_code: -1_000_000 })).toBe(true);
    expect(ok({ exit_code: 1_000_001 })).toBe(false);
    expect(ok({ exit_code: -1_000_001 })).toBe(false);
    expect(ok({ duration_ms: 604_800_000 })).toBe(true);
    expect(ok({ duration_ms: 604_800_001 })).toBe(false);
    expect(ok({ skipped_tests: 100_000_000 })).toBe(true);
    expect(ok({ skipped_tests: 100_000_001 })).toBe(false);
    expect(ok({ timed_out: true, exit_code: null })).toBe(true);
    expect(ok({ timed_out: true, exit_code: 0 })).toBe(false);
    expect(ok({ timed_out: true, exit_code: 143 })).toBe(false);
    expect(done({ check: { ...CHECK, timed_out: true } }).success).toBe(false);
    // a NUL in the summary would abort the cloud's finish
    expect(ok({ summary: "before\u0000after" })).toBe(false);
    expect(ok({ summary: "\u0000" })).toBe(false);
    expect(ok({ summary: "tab\tand newline\nare fine" })).toBe(true);
  });
});

describe("D#6 R-CHK-2: the run ends check_failed", () => {
  const event = { seq: 3, ts: "2026-10-22T10:00:00.000Z", type: "run_ended" };
  it("is a reason of run_ended whose only detail is check_no_dev_shell", () => {
    expect(DETAILS_OF_RUN_ENDED.check_failed).toEqual(["check_no_dev_shell"]);
    expect(LocalOnlyEvent.safeParse({ ...event, reason: "check_failed" }).success).toBe(true);
    expect(LocalOnlyEvent.safeParse({ ...event, reason: "check_failed", detail: "check_no_dev_shell" }).success).toBe(true);
    expect(LocalOnlyEvent.safeParse({ ...event, reason: "check_failed", detail: "other" }).success).toBe(false);
    expect(LocalOnlyEvent.safeParse({ ...event, reason: "wall_clock", detail: "check_no_dev_shell" }).success).toBe(false);
  });

  it("the runner declares the version that first runs a check", () => {
    expect(CURRENT_PROTOCOL_VERSION).toBe(CHECK_JOB_MIN_PROTOCOL);
  });
});
