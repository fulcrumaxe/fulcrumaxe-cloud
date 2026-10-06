import { describe, expect, it } from "vitest";
import {
  conformanceViolations,
  loadConformanceFixtures,
  type ConformanceDriver,
  type ConformanceRun,
} from "@fx/runtime/test/backends/conformance.contract.js";
import { claudeCodeConformanceDriver as real } from "../helpers/backendConformanceDriver.js";

/** D#221 R1b: Claude Code through the backend conformance suite, and the proof that the suite can fail. */
const fx = loadConformanceFixtures("claude-code");

describe("claude-code conforms", () => {
  it("has no violation over its recorded fixtures", async () => {
    expect(await conformanceViolations(real, fx)).toEqual([]);
  });
});

/** The real driver with the result of every `run` rewritten: one rule broken per mutant. */
const mutatedRun = (fn: (r: ConformanceRun, io: Parameters<ConformanceDriver["run"]>[0]) => ConformanceRun): ConformanceDriver => ({
  ...real,
  run: async (io) => fn(await real.run(io), io),
});
const mapEvents = (r: ConformanceRun, f: (e: ConformanceRun["delivered"][number]) => ConformanceRun["delivered"][number]): ConformanceRun => ({
  ...r,
  delivered: r.delivered.map(f),
  last: r.last && f(r.last),
});

const FIELDS = ["inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens"] as const;
const zero = () => ({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 });
/** Output-rewrite stand-ins for #259's two per-id mutations; the real-code ones are applied by hand (see the PR body). */
const sumLines = (events: ConformanceRun["delivered"]) => {
  const t = zero();
  for (const e of events) for (const f of FIELDS) t[f] += e.usage?.[f] ?? 0;
  return t;
};
const lastPerId = (events: ConformanceRun["delivered"]) => {
  const held = new Map<string, ReturnType<typeof zero>>();
  for (const e of events) if (e.messageId !== undefined && e.usage) held.set(e.messageId, { ...zero(), ...e.usage });
  const t = zero();
  for (const h of held.values()) for (const f of FIELDS) t[f] += h[f];
  return t;
};

const MUTANTS: [rule: string, name: string, driver: ConformanceDriver][] = [
  ["EV-MAP", "drops the tool uses", mutatedRun((r) => mapEvents(r, ({ toolUses: _t, ...e }) => e))],
  ["EV-MAP", "reports a clean line invalid", mutatedRun((r) => ({ ...r, invalid: [...r.invalid, "shape"] }))],
  ["EV-ID", "takes the run id from the line", mutatedRun((r) => mapEvents(r, (e) => ({ ...e, runId: "run-FORGED" })))],
  ["EV-ID", "takes the seq from the line", mutatedRun((r) => mapEvents(r, (e) => ({ ...e, seq: -5 })))],
  ["EV-ID", "does not stamp the backend", mutatedRun((r) => mapEvents(r, ({ backend: _b, ...e }) => e))],
  ["EV-ID", "takes the backend from the line", mutatedRun((r) => mapEvents(r, (e) => ({ ...e, backend: "forged-backend" })))],
  ["EV-SETTLE", "settles the reported figure over the metered one", { ...real, settle: (last) => real.settle(last, 0) }],
  ["EV-SETTLE", "settles nothing for a reported figure", { ...real, settle: (last, m) => real.settle(last && { ...last, costUsd: undefined }, m) }],
  ["MP-MSG", "keeps an id-less usage line", mutatedRun((r, io) => (io.stdout.length === 2 && io.stdout[0]!.includes("5000000") ? { ...r, delivered: [{ ...r.delivered[0]!, messageId: undefined, usage: { inputTokens: 5_000_000, outputTokens: 0 } }, ...r.delivered] } : r))],
  ["MP-SRC", "reads stderr as stdout", mutatedRun((r, io) => (io.stderr?.length ? { ...r, delivered: [{ ...r.last!, type: "assistant" }], last: { ...r.last!, type: "result", isError: false } } : r))],
  ["MP-MSG", "sums every line instead of each id's maximum", { ...real, meter: (events) => ({ ...real.meter(events), total: sumLines(events) }) }],
  ["MP-MSG", "lets a later lower figure replace the held one", { ...real, meter: (events) => ({ ...real.meter(events), total: lastPerId(events) }) }],
  ["MP-PLAUS", "meters without a ceiling", { ...real, meter: (events) => ({ total: real.meter(events).total, inputSideTokens: events.reduce((n, e) => n + (e.usage?.inputTokens ?? 0), 0), implausible: false, flags: [] }) }],
  ["MP-PLAUS", "clamps but never flags", { ...real, meter: (events) => ({ ...real.meter(events), implausible: false, flags: [] }) }],
  ["EXIT", "succeeds on exit 0 with no terminal line", mutatedRun((r, io) => (io.exit === 0 && r.last?.type === "error" && io.stdout.length === 1 && !io.stderr ? { ...r, last: { ...r.last, type: "result", isError: false } } : r))],
  ["EXIT", "succeeds on a terminal line whatever the exit", mutatedRun((r, io) => (io.exit !== 0 && io.stdout.length > 1 ? { ...r, last: { ...r.delivered.at(-1)!, type: "result", isError: false } } : r))],
];

describe("the suite catches a broken rule (mutation proofs)", () => {
  it.each(MUTANTS)("%s: %s", async (rule, _name, driver) => {
    const violations = await conformanceViolations(driver, fx);
    expect(violations.length, "the mutant went unnoticed").toBeGreaterThan(0);
    expect(violations.some((v) => v.startsWith(`${rule}:`)), violations.join(" | ")).toBe(true);
  });
});
