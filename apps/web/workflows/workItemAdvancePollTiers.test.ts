import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILD_TIERS, CI_TIERS, FOLLOW_TIERS, REVIEW_TIERS, pollsFor, type Tiers } from "./pollTiers.testkit";

/**
 * Platform-floor cost: the pacing of the workflows' poll loops. The tables are written out in pollTiers.testkit.ts by hand; this holds the workflow sources to
 * them, pins the number of asks a full wait makes, and pins the polls that must NOT change because something else reads their cadence.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const advance = readFileSync(join(HERE, "workItemAdvance.ts"), "utf8");
const follow = readFileSync(join(HERE, "agentRunFollow.ts"), "utf8");
const MIN = 60_000;

/** `[[0, 60_000], [10 * 60_000, 120_000]]` as written in the source, evaluated. */
function tableIn(src: string, name: string): Tiers {
  const m = new RegExp(`const ${name}: ReadonlyArray<readonly \\[(?:startMs: )?number, (?:pauseMs: )?number\\]> = (\\[\\[.*\\]\\]);`).exec(src);
  if (!m) throw new Error(`no table ${name}`);
  return Function(`"use strict"; const CI_POLL_MS = 60_000; return (${m[1]});`)() as Tiers;
}

describe("the poll tiers in the workflow sources are the ones the tests assume", () => {
  it.each([
    ["BUILD_POLL_TIERS", BUILD_TIERS, advance],
    ["REVIEW_POLL_TIERS", REVIEW_TIERS, advance],
    ["CI_POLL_TIERS", CI_TIERS, advance],
    ["POLL_TIERS", FOLLOW_TIERS, follow],
  ] as const)("%s", (name, expected, src) => {
    expect(tableIn(src, name)).toEqual(expected);
  });

  it("every table starts at zero and gets slower, never faster, as the wait grows (a slower tier is what makes a long wait cheap)", () => {
    for (const t of [BUILD_TIERS, REVIEW_TIERS, CI_TIERS, FOLLOW_TIERS]) {
      expect(t[0]![0]).toBe(0);
      for (let i = 1; i < t.length; i++) {
        expect(t[i]![0]).toBeGreaterThan(t[i - 1]![0]);
        expect(t[i]![1]).toBeGreaterThan(t[i - 1]![1]);
      }
    }
  });

  it("the longest pause is bounded so a finished run or CI is noticed within it: build 4 min, review 2 min, CI 5 min, follower 5 min (the follower's is only the backstop to its hook)", () => {
    expect(Math.max(...BUILD_TIERS.map((t) => t[1]))).toBe(4 * MIN);
    expect(Math.max(...REVIEW_TIERS.map((t) => t[1]))).toBe(2 * MIN);
    expect(Math.max(...CI_TIERS.map((t) => t[1]))).toBe(5 * MIN);
    expect(Math.max(...FOLLOW_TIERS.map((t) => t[1]))).toBe(5 * MIN);
  });
});

describe("asks made by one full wait, before and after", () => {
  it("a build that runs out its 250 minutes: 250 asks at a minute, now 83", () => {
    expect(pollsFor(BUILD_TIERS, 250 * MIN)).toBe(83);
  });
  it("a reviewer that runs out its 45 minutes: 90 asks, now 38", () => {
    expect(pollsFor(REVIEW_TIERS, 45 * MIN)).toBe(38);
  });
  it("CI that never settles in two hours: 65 asks, now 38", () => {
    expect(pollsFor(CI_TIERS, 120 * MIN)).toBe(38);
  });
  it("a run followed to a four-hour watchdog: 240 status reads, now 60", () => {
    expect(pollsFor(FOLLOW_TIERS, 240 * MIN)).toBe(60);
  });
  it("short waits are unchanged: the first ten minutes of a build and of CI still ask every minute", () => {
    expect(pollsFor(BUILD_TIERS, 10 * MIN)).toBe(10);
    expect(pollsFor(CI_TIERS, 10 * MIN)).toBe(10);
  });
});

describe("polls that keep their pace because something else reads their cadence", () => {
  // The stalled-item check treats a waiting fact older than half an hour as not refreshed, and the parked-stage sweep restarts a build whose latest slot or capacity
  // fact is two asks old: both assume these asks come every minute (the spend wait every five). Slowing them would make a live workflow look abandoned.
  it.each([
    "const BUILD_SLOT_POLL_MS = 60_000;",
    "const CAPACITY_POLL_MS = 60_000;",
    "const BUILD_SPEND_POLL_MS = 300_000;",
    "const MERGE_QUEUE_WAIT_POLL_MS = 2 * 60_000;",
    "const MERGE_REPO_BUSY_POLL_MS = 30_000;",
    "const MERGE_ORDER_POLL_MS = 30_000;",
    "const POLL_MS = 20_000;",
    "const PR_GRACE_POLL_MS = 20_000;",
  ])("%s", (line) => {
    expect(advance).toContain(line);
  });

  it("the budgets the polls are counted against are unchanged: build 250 min, review 45, CI two hours, runner pending ceiling 73 hours", () => {
    expect(advance).toContain("const BUILD_WAIT_MS = 250 * 60_000;");
    expect(advance).toContain("const REVIEW_WAIT_MS = 45 * 60_000;");
    expect(advance).toContain("const CI_WAIT_MS = 120 * 60_000;");
    expect(advance).toContain("const RUNNER_PENDING_CEILING_MS = 73 * 3_600_000;");
  });

  it("every loop adds the pause it slept to its budget, never a fixed number", () => {
    expect(advance).not.toMatch(/waited \+= BUILD_POLL_MS|pendingWaited \+= BUILD_POLL_MS|waited \+= REVIEW_POLL_MS|pendingWaited \+= REVIEW_POLL_MS/);
    expect(advance.match(/const pause = tieredPause\(waited \+ pendingWaited, BUILD_POLL_TIERS\);/g)).toHaveLength(4);
    expect(advance.match(/const pause = tieredPause\(waited \+ pendingWaited, REVIEW_POLL_TIERS\);/g)).toHaveLength(1);
    expect(advance.match(/const pause = tieredPause\(waited, CI_POLL_TIERS\);/g)).toHaveLength(3);
  });
});
