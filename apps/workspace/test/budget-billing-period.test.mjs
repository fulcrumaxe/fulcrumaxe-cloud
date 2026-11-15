// apps/workspace/test/budget-billing-period.test.mjs
//
// Issue #810: the "This month" section's first line is built by periodWords(), next to dateWords()
// in budget-billing-app.js. It formats in UTC regardless of the process time zone, and returns ""
// for anything that is not a readable date so the caller can render nothing.
//
// The module registers itself with window.FULC on import, as every first-party app entry does, and
// its live-client import (core/cloud-live.js) needs a real browser (BroadcastChannel, Web Locks) to
// load -- neither of which periodWords() touches, so both are stood in for before the dynamic import.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shell/core/cloud-live.js", () => ({ on: () => () => {}, onRefresh: () => () => {} }));
globalThis.window = { FULC: { register: () => {} } };
const { periodWords } = await import("../apps/budget-billing/budget-billing-app.js");

describe("periodWords()", () => {
  it("formats a readable ISO date in words", () => {
    expect(periodWords("2026-11-01T00:00:00.000Z")).toBe("Month starting Nov 1, 2026.");
    expect(periodWords("2026-09-01T00:00:00.000Z")).toBe("Month starting Sep 1, 2026.");
  });

  describe("time zone independence", () => {
    let original;
    beforeEach(() => {
      original = process.env.TZ;
    });
    afterEach(() => {
      process.env.TZ = original;
    });

    it("is the same in Pacific/Kiritimati (UTC+14) and Pacific/Pago_Pago (UTC-11)", () => {
      process.env.TZ = "Pacific/Kiritimati";
      expect(periodWords("2026-11-01T00:00:00.000Z")).toBe("Month starting Nov 1, 2026.");
      process.env.TZ = "Pacific/Pago_Pago";
      expect(periodWords("2026-11-01T00:00:00.000Z")).toBe("Month starting Nov 1, 2026.");
    });
  });

  it("returns '' for anything that is not a readable date", () => {
    for (const input of [undefined, null, "", "   ", "not-a-date", 20261101, {}]) {
      expect(periodWords(input)).toBe("");
    }
  });
});
