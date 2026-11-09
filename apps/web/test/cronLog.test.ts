import { afterEach, describe, expect, it, vi } from "vitest";
import { gateLine, type TickGate } from "@fx/core/src/pendingWork";
import { cronLog } from "../lib/cronLog";

/** The sink every cron route logs through: an idle tick's gate line is dropped unless asked for; everything else is written as before. */
const gate = (over: Partial<TickGate> = {}): TickGate => ({ name: "merge-queue-sweep", connect: false, reason: "none", marker: "miss", markerValue: null, lastRun: "hit", paused: false, ...over });

afterEach(() => vi.restoreAllMocks());

describe("cronLog", () => {
  it("drops the gate line of a tick that did not connect", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    cronLog(gateLine(gate()), {});
    expect(out).not.toHaveBeenCalled();
  });

  it("writes it when FX_LOG_SKIPPED_TICKS is exactly 1, and not for any other value", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    cronLog(gateLine(gate()), { FX_LOG_SKIPPED_TICKS: "1" });
    expect(out).toHaveBeenCalledTimes(1);
    cronLog(gateLine(gate()), { FX_LOG_SKIPPED_TICKS: "true" });
    expect(out).toHaveBeenCalledTimes(1);
  });

  it("always writes a connecting tick's line (why it connected, whether it found work) and every other line", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const connected = gateLine(gate({ connect: true, reason: "marker" }), true);
    const refused = JSON.stringify({ event: "cron.refused", route: "/api/cron/x", reason: "missing" });
    cronLog(connected, {});
    cronLog("merge queue sweep: worker not configured", {});
    cronLog(refused, {});
    expect(out.mock.calls.map((c) => c[0])).toEqual([connected, "merge queue sweep: worker not configured", refused]);
  });
});
