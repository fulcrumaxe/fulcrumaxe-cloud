import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUN_LIMIT_BOUNDS, RUN_LIMIT_INTEGER_KEYS, type RunLimitKey } from "@fx/core/src/run-limits/limits.js";
import { ROLE_MANIFEST } from "@fx/roles";
import { loadRoleCard } from "@fx/roles/cards";
import { SANDBOX_MAX_TIMEOUT_MS, SANDBOX_TIMEOUT_MARGIN_MS } from "@fx/runner";
import { isClaudeModelId } from "@fx/spend";
import { RUN_TIME_CEILING_MS, TIER_TO_MODEL_ID, boundedLimit, runnerLimitsFrom, sandboxTimeFor } from "../src/seat.js";

const MIN = 60_000;
const DEFAULTS = Object.fromEntries(Object.entries(RUN_LIMIT_BOUNDS).map(([k, b]) => [k, b.default])) as Record<RunLimitKey, number>;

describe("seat: limits mapping (one table)", () => {
  it("maps core's minutes and snake_case to the runner's milliseconds and camelCase", () => {
    expect(runnerLimitsFrom({ ...DEFAULTS, max_run_minutes: 30, max_turns: 17, max_model_calls: 40, silence_minutes: 11, max_extensions: 1, per_run_usd: 12.5 })).toEqual({
      limits: { maxRunMs: 30 * MIN, maxTurns: 17, maxModelCalls: 40, meteringSilenceMs: 11 * MIN },
      maxExtensions: 1,
      perRunUsd: 12.5,
    });
  });

  it("R-BOUNDS (a): every field is held to the floor and ceiling core publishes (read from the table, not copied)", () => {
    for (const key of Object.keys(RUN_LIMIT_BOUNDS) as RunLimitKey[]) {
      const b = RUN_LIMIT_BOUNDS[key];
      expect(boundedLimit(key, b.ceiling + 1000)).toBe(b.ceiling);
      expect(boundedLimit(key, b.floor - 1)).toBe(b.floor);
      expect(boundedLimit(key, b.floor)).toBe(b.floor);
      expect(boundedLimit(key, b.ceiling)).toBe(b.ceiling);
      for (const junk of [Number.NaN, Number.POSITIVE_INFINITY, "60", null, undefined]) expect(boundedLimit(key, junk)).toBe(b.default);
    }
    for (const key of RUN_LIMIT_INTEGER_KEYS) expect(Number.isInteger(boundedLimit(key, RUN_LIMIT_BOUNDS[key].floor + 0.7))).toBe(true);
  });

  it("R-BOUNDS (a): a resolved set outside the bounds reaches the runner inside them", () => {
    const wild = { max_run_minutes: 9999, max_turns: 1, max_model_calls: 99999, silence_minutes: 1, max_extensions: 99, max_resumes: 0, per_run_usd: 5000 } as Record<RunLimitKey, number>;
    const { limits, maxExtensions, perRunUsd } = runnerLimitsFrom(wild);
    expect(limits).toEqual({
      maxRunMs: RUN_LIMIT_BOUNDS.max_run_minutes.ceiling * MIN,
      maxTurns: RUN_LIMIT_BOUNDS.max_turns.floor,
      maxModelCalls: RUN_LIMIT_BOUNDS.max_model_calls.ceiling,
      meteringSilenceMs: RUN_LIMIT_BOUNDS.silence_minutes.floor * MIN,
    });
    expect(maxExtensions).toBe(RUN_LIMIT_BOUNDS.max_extensions.ceiling);
    expect(perRunUsd).toBe(RUN_LIMIT_BOUNDS.per_run_usd.ceiling);
  });

});

describe("seat: the sandbox timeout (D-TIMEOUT)", () => {
  const limits = (maxRunMs: number) => ({ maxRunMs, maxTurns: 100, maxModelCalls: 300, meteringSilenceMs: 15 * MIN });

  it("is the longest possible run (every extension taken) plus the margin: the default run is 120 + 10 minutes", () => {
    expect(sandboxTimeFor(limits(60 * MIN), 2)).toEqual({ maxPossibleRunMs: 120 * MIN, timeoutMs: 130 * MIN });
    expect(sandboxTimeFor(limits(30 * MIN), 1)).toEqual({ maxPossibleRunMs: 45 * MIN, timeoutMs: 55 * MIN });
    expect(sandboxTimeFor(limits(30 * MIN), 0)).toEqual({ maxPossibleRunMs: 30 * MIN, timeoutMs: 40 * MIN });
  });

  it("never plans a run past the platform ceiling", () => {
    expect(sandboxTimeFor(limits(200 * MIN), 4)).toEqual({ maxPossibleRunMs: RUN_TIME_CEILING_MS, timeoutMs: RUN_TIME_CEILING_MS + SANDBOX_TIMEOUT_MARGIN_MS });
    expect(RUN_TIME_CEILING_MS).toBe(RUN_LIMIT_BOUNDS.max_run_minutes.ceiling * MIN);
  });

  it("10: the extension slice is defined once, in the runner's decision, and the seat imports it, so the plan and the run cannot drift", () => {
    const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const defining = ["worker", "runner"].flatMap((pkg) =>
      readdirSync(path.join(src, pkg, "src"), { recursive: true, encoding: "utf8" })
        .filter((f) => f.endsWith(".ts") && /\bconst EXTENSION_SLICE_FRACTION\b/.test(readFileSync(path.join(src, pkg, "src", f), "utf8")))
        .map((f) => `${pkg}/${f}`),
    );
    expect(defining).toEqual(["runner/runLimitDecision.ts"]);
    expect(readFileSync(path.join(src, "worker", "src", "seat.ts"), "utf8")).toMatch(/import \{[^}]*\bEXTENSION_SLICE_FRACTION\b[^}]*\} from "@fx\/runner"/);
  });

  it("R-MAX: the platform maximum is Vercel's documented 24 hours for Pro, and the largest run the bounds allow fits under it", () => {
    expect(SANDBOX_MAX_TIMEOUT_MS).toBe(24 * 60 * MIN);
    expect(sandboxTimeFor(limits(RUN_TIME_CEILING_MS), RUN_LIMIT_BOUNDS.max_extensions.ceiling).timeoutMs).toBeLessThan(SANDBOX_MAX_TIMEOUT_MS);
    expect(45 * MIN).toBeLessThan(sandboxTimeFor(limits(60 * MIN), 2).timeoutMs); // a Hobby sandbox (45 min) would refuse the default run
  });
});

describe("seat: model and card sources", () => {
  it("the tier table maps every manifest tier to a priced model id, and only to one", () => {
    for (const entry of ROLE_MANIFEST) expect(isClaudeModelId(TIER_TO_MODEL_ID[entry.defaultModel] ?? ""), entry.name).toBe(true);
    for (const id of Object.values(TIER_TO_MODEL_ID)) expect(isClaudeModelId(id)).toBe(true);
  });

  it("every manifest role has a card with text; a name outside the manifest never reaches the filesystem", () => {
    for (const entry of ROLE_MANIFEST) expect(loadRoleCard(entry.name)?.length ?? 0, entry.name).toBeGreaterThan(100);
    for (const name of ["", "nope", "../manifest", "../../package", "executor/../executor"]) expect(loadRoleCard(name), name).toBeUndefined();
  });
});
