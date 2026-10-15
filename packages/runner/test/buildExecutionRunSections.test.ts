import { describe, expect, it } from "vitest";
import { buildExecutionRun, type StartAgentRunInput } from "../src/startAgentRun.js";

/** D#600 CX-2: the section list the prompt assembler returns reaches the run the sandbox target records the ledger from. */
const INPUT = {
  accountId: "00000000-0000-4000-8000-000000000001",
  repoId: "00000000-0000-4000-8000-000000000002",
  role: "executor",
  product: "team",
  roleCard: "card",
  prompt: "prompt",
  model: "m",
  capUsd: 1,
  spend: { plan: "starter" },
} as unknown as StartAgentRunInput;

describe("buildExecutionRun: contextSections", () => {
  it("copies the list, and a start without one leaves the run without one", () => {
    const sections = [{ code: "spec" as const, bytes: 12, sha256: "c".repeat(64), trimmed_bytes: 0 }];
    expect(buildExecutionRun("run-1", { ...INPUT, contextSections: sections }).contextSections).toEqual(sections);
    expect(buildExecutionRun("run-1", INPUT).contextSections).toBeUndefined();
  });
});
