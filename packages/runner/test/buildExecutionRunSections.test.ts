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

describe("buildExecutionRun: memoryTokens (D#601 MEM-3)", () => {
  it("copies the figure, zero included, and leaves it absent when the start gave none", () => {
    expect(buildExecutionRun("run-1", { ...INPUT, memoryTokens: 25 }).memoryTokens).toBe(25);
    expect(buildExecutionRun("run-1", { ...INPUT, memoryTokens: 0 }).memoryTokens).toBe(0);
    expect(buildExecutionRun("run-1", INPUT).memoryTokens).toBeUndefined();
  });
});

describe("buildExecutionRun: contextSections", () => {
  it("copies the list, and a start without one leaves the run without one", () => {
    const sections = [{ code: "spec" as const, bytes: 12, sha256: "c".repeat(64), trimmed_bytes: 0 }];
    expect(buildExecutionRun("run-1", { ...INPUT, contextSections: sections }).contextSections).toEqual(sections);
    expect(buildExecutionRun("run-1", INPUT).contextSections).toBeUndefined();
  });
});

describe("buildExecutionRun: the diff base of a fix round (FIXROUND-REPUBLISH R2-c0)", () => {
  const B = "b".repeat(40);
  it("a fresh continuation's base belongs to the branch it continues; a same-side resume names its own branch; a start with neither carries none", () => {
    const fresh = buildExecutionRun("run-1", { ...INPUT, continues: { branch: "fx/issue-12", prNumber: 7, baseSha: B } });
    expect([fresh.continuesBaseSha, fresh.continuesBaseBranch]).toEqual([B, "fx/issue-12"]);
    const resumed = buildExecutionRun("run-1", { ...INPUT, base: { sha: B, branch: "fx/run-branch" } });
    expect([resumed.continuesBaseSha, resumed.continuesBaseBranch, resumed.continuesBranch]).toEqual([B, "fx/run-branch", undefined]);
    const none = buildExecutionRun("run-1", { ...INPUT, continues: { branch: "fx/issue-12", prNumber: 7 } });
    expect([none.continuesBaseSha, none.continuesBaseBranch]).toEqual([undefined, undefined]);
  });
});
