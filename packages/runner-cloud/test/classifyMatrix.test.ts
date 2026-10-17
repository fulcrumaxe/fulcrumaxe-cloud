import { describe, expect, it } from "vitest";
import { classifyRunner } from "../src/readModel.js";

const NOW = new Date("2026-10-16T12:00:00.000Z");
const ago = (s: number): Date => new Date(NOW.getTime() - s * 1000);
const base = { revokedAt: null, protocolVersion: 2, lastSeenAt: ago(10), busy: false } as const;

/**
 * The whole state matrix (D#605 FL-3 and FL-8, 2026-10-16 staging check): which of the five words a runner reads as for each combination of
 * the two person-set flags, whether it has work running, and whether it is heard from. A drain with nothing left to finish reads `paused`
 * (FL-8 acceptance 5), with `draining: true` still reported beside it so the page can tell it from a pause.
 */
describe("classifyRunner: paused and draining across busy and quiet, online and offline", () => {
  const rows: Array<[string, Partial<Parameters<typeof classifyRunner>[0]>, string]> = [
    ["online, idle", {}, "online_idle"],
    ["online, running work", { busy: true }, "busy"],
    ["offline (quiet for 5 minutes)", { lastSeenAt: ago(300) }, "offline"],
    ["paused, idle", { paused: true }, "paused"],
    ["paused, running work", { paused: true, busy: true }, "paused"],
    ["paused and quiet for 5 minutes", { paused: true, lastSeenAt: ago(300) }, "paused"],
    ["draining with work still running", { draining: true, busy: true }, "draining"],
    ["draining, nothing left to finish", { draining: true }, "paused"],
    ["draining, quiet for 5 minutes", { draining: true, lastSeenAt: ago(300) }, "paused"],
    ["paused and draining, work running", { paused: true, draining: true, busy: true }, "paused"],
    ["paused and draining, idle", { paused: true, draining: true }, "paused"],
  ];
  for (const [name, facts, want] of rows) {
    it(`${name} reads ${want}`, () => {
      expect(classifyRunner({ ...base, ...facts }, NOW, 1)).toBe(want);
    });
  }
});
