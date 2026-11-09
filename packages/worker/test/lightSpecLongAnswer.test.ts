import { describe, expect, it } from "vitest";
import { MAX_ENVELOPE_INPUT_BYTES } from "@fulcrumaxe/runner-protocol";
import { publishLightSpec } from "@fx/pipeline";
import type { Pool } from "pg";
import { DROPPED_AGENT_OUTPUT, storedAgentOutput } from "../src/runnerDone.js";

/**
 * The runner path of a long PM answer: the runner sends the parsed final block, the cloud stores it through `storedAgentOutput`, and the short Spec step reads the stored
 * envelope. An answer over the size cap is stored as a marker with no `spec`; before the named checks that read as an empty Spec ("invalid_spec_output") although the run
 * had succeeded. These tests pin both ends: what is stored, and the code the step then names.
 */
const NO_POOL = new Proxy({}, { get: () => { throw new Error("the store must not be reached"); } }) as unknown as Pool;
const answer = (spec: string) => ({ feasible: true, reason: "", summary: "s", spec, acceptance_files: ["src/a.ts"], split_proposed: false, planned_prs: [] });

describe("a long project-manager answer on the runner path", () => {
  it("an answer well over the model's usual length is stored whole", () => {
    const long = answer("1. criterion\n".repeat(6_000));
    expect(Buffer.byteLength(JSON.stringify(long), "utf8")).toBeGreaterThan(60_000);
    expect(storedAgentOutput(long)).toEqual(long);
  });

  it("an answer over the cap is stored as the dropped marker, and the step names that, not an empty Spec", async () => {
    const huge = answer("x".repeat(MAX_ENVELOPE_INPUT_BYTES + 1));
    const stored = storedAgentOutput(huge);
    expect(stored).toEqual({ ...DROPPED_AGENT_OUTPUT });
    expect(await publishLightSpec(NO_POOL, "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", stored)).toEqual({ status: "refused", reason: "light_answer_too_large" });
  });
});
