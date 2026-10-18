import { describe, expect, it } from "vitest";
import { JOB_ENV_NAMES, cleanEnv } from "../src/job/cleanEnv.js";

/**
 * D#600 CX-6a: the two context levers are fixed constants on every job. The daemon's hooks stay off (the context note is CX-6b), so this is the
 * only context control a customer machine gets in this row.
 */
describe("the context levers in the job environment", () => {
  it("are job variables by name, and every run holds them with or without allowances", () => {
    expect(JOB_ENV_NAMES).toEqual(expect.arrayContaining(["BASH_MAX_OUTPUT_LENGTH", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"]));
    for (const options of [undefined, { jobEnv: {} }]) {
      const env = cleanEnv({ mode: "subscription" }, options);
      expect(env.BASH_MAX_OUTPUT_LENGTH).toBe("30000");
      expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("85");
    }
  });

  it("cannot be changed by a job, a host variable or the API-key mode", () => {
    const before = { a: process.env.BASH_MAX_OUTPUT_LENGTH, b: process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE };
    process.env.BASH_MAX_OUTPUT_LENGTH = "999999";
    process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = "99";
    try {
      const env = cleanEnv({ mode: "api_key", apiKey: "sk-test" }, { jobEnv: { BASH_MAX_OUTPUT_LENGTH: "1", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "5" } });
      expect(env.BASH_MAX_OUTPUT_LENGTH).toBe("30000");
      expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("85");
    } finally {
      for (const [k, v] of [["BASH_MAX_OUTPUT_LENGTH", before.a], ["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", before.b]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
