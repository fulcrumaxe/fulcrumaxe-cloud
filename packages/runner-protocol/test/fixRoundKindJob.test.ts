import { describe, expect, it } from "vitest";
import { CURRENT_PROTOCOL_VERSION, FIX_ROUND_KIND_JOB_MIN_PROTOCOL } from "../src/messages.js";
import { FIX_ROUND_KINDS, SignedJobSchema } from "../src/job.js";
import { canonicalJson } from "../src/jobSignature.js";
import { sampleJob } from "./helpers/sampleJob.js";

// D#6 RUNNER-CHECK-SKIP-NO-COMMIT: the `fix_round_kind` job key.
const PARENT = "5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d";
const CONTINUES = { parent_run_id: PARENT, session_id: "s-1", branch: `fx/${PARENT}-g1` };
const sig = "A".repeat(86);
const signed = (job: unknown) => SignedJobSchema.safeParse({ job, signature: sig });
const fixJob = (extra: Record<string, unknown> = {}) => {
  const base = sampleJob() as { task: { prompt: string; prompt_sha256: string } };
  return sampleJob({ continues: CONTINUES, task: { kind: "fix", prompt: base.task.prompt, prompt_sha256: base.task.prompt_sha256 }, ...extra });
};

describe("the fix_round_kind job key", () => {
  it("is protocol 17, the current version is at least it, and the kinds are closed", () => {
    expect(FIX_ROUND_KIND_JOB_MIN_PROTOCOL).toBe(17);
    expect(CURRENT_PROTOCOL_VERSION).toBeGreaterThanOrEqual(FIX_ROUND_KIND_JOB_MIN_PROTOCOL);
    expect([...FIX_ROUND_KINDS]).toEqual(["check_fix", "review_fix"]);
  });

  it("is accepted on an executor fix job that continues a branch, for both kinds, and a job without it still parses", () => {
    for (const kind of FIX_ROUND_KINDS) expect(signed(fixJob({ fix_round_kind: kind })).success).toBe(true);
    expect(signed(fixJob()).success).toBe(true);
  });

  it("refuses any other word, a null, and a job that is not an executor's continuing fix round", () => {
    for (const bad of ["conflict", "", null, 1]) expect(signed(fixJob({ fix_round_kind: bad })).success).toBe(false);
    expect(signed(sampleJob({ fix_round_kind: "review_fix" })).success).toBe(false);
    expect(signed(fixJob({ continues: null, fix_round_kind: "review_fix" })).success).toBe(false);
    expect(signed(fixJob({ role: "code-reviewer", fix_round_kind: "review_fix" })).success).toBe(false);
    expect(signed(fixJob({ conflict_round: { from_sha: "a".repeat(40), base_sha: "b".repeat(40), base_ref: "main" }, fix_round_kind: "review_fix" })).success).toBe(false);
  });

  it("is part of the signed bytes, and a job without it has the bytes it had before", () => {
    const a = canonicalJson(fixJob({ fix_round_kind: "review_fix" }));
    const b = canonicalJson(fixJob({ fix_round_kind: "check_fix" }));
    const none = canonicalJson(fixJob());
    expect(a).not.toBe(b);
    expect(none).not.toContain("fix_round_kind");
  });
});
