import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { CONFLICT_ATTEST_JOB_MIN_PROTOCOL, CURRENT_PROTOCOL_VERSION, ConflictAttestation, DoneMessage, MAX_CONFLICT_ATTEST_PATHS } from "../src/messages.js";
import { JobConflictRoundSchema, JobSchema, SignedJobSchema } from "../src/job.js";
import { canonicalJson, signJob } from "../src/jobSignature.js";
import { sampleJob } from "./helpers/sampleJob.js";

// D#519 MQ4-e2-c1: the `conflict_round` job key and the attestation on `done`.
const FROM = "a".repeat(40);
const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const PARENT = "5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d";
const KEY = { from_sha: FROM, base_sha: BASE, base_ref: "main" };
const CONTINUES = { parent_run_id: PARENT, session_id: "s-1", branch: `fx/${PARENT}-g1` };
const FIX = { task: { kind: "fix", prompt: "x", prompt_sha256: "" } };
const fixJob = (extra: Record<string, unknown> = {}) => {
  const base = sampleJob() as { task: { prompt: string } };
  const { prompt } = base.task;
  return sampleJob({ continues: CONTINUES, task: { ...FIX.task, prompt, prompt_sha256: (sampleJob() as { task: { prompt_sha256: string } }).task.prompt_sha256 }, ...extra });
};
const sig = "A".repeat(86);
const signed = (job: unknown) => SignedJobSchema.safeParse({ job, signature: sig });

describe("the conflict_round job key", () => {
  it("is protocol 14, and the current version is at least it", () => {
    expect(CONFLICT_ATTEST_JOB_MIN_PROTOCOL).toBe(14);
    expect(CURRENT_PROTOCOL_VERSION).toBeGreaterThanOrEqual(CONFLICT_ATTEST_JOB_MIN_PROTOCOL);
  });

  it("holds exactly three strict fields: two 40-hex shas and a plain branch name", () => {
    expect(Object.keys(JobConflictRoundSchema.shape).sort()).toEqual(["base_ref", "base_sha", "from_sha"]);
    expect(JobConflictRoundSchema.safeParse(KEY).success).toBe(true);
    expect(JobConflictRoundSchema.safeParse({ ...KEY, extra: 1 }).success).toBe(false);
    for (const bad of [{ from_sha: "A".repeat(40) }, { from_sha: "a".repeat(39) }, { base_sha: "b".repeat(64) }, { base_ref: "a..b" }, { base_ref: "" }, { base_ref: "x y" }]) {
      expect(JobConflictRoundSchema.safeParse({ ...KEY, ...bad }).success).toBe(false);
    }
  });

  it("is accepted on an executor fix job that continues a branch", () => {
    expect(signed(fixJob({ conflict_round: KEY })).success).toBe(true);
  });

  it("is refused on a non-fix job, a non-executor job, or a job with no continuation", () => {
    expect(signed(sampleJob({ conflict_round: KEY })).success).toBe(false);
    expect(signed(fixJob({ continues: null, conflict_round: KEY })).success).toBe(false);
    expect(signed(fixJob({ role: "code-reviewer", conflict_round: KEY })).success).toBe(false);
    const implement = sampleJob({ continues: CONTINUES, conflict_round: KEY });
    expect(signed(implement).success).toBe(false);
  });

  it("is omitted, never null, on every other job: their canonical JSON and signature do not change", () => {
    const plain = sampleJob();
    expect(canonicalJson(plain)).not.toContain("conflict_round");
    expect(JobSchema.safeParse({ ...(plain as object), conflict_round: null }).success).toBe(false);
    const { privateKey } = generateKeyPairSync("ed25519");
    const a = signJob(JobSchema.parse(plain), privateKey);
    const b = signJob(JobSchema.parse(JSON.parse(JSON.stringify(plain))), privateKey);
    expect(a.signature).toBe(b.signature);
  });
});

describe("the conflict attestation on done", () => {
  const body = { head: HEAD, parents: [FROM, BASE], from_sha: FROM, base_sha: BASE, history: "descendant", pushed_by_round: true, second_parent_on_default: true, still_conflicting: "no", touched_paths: ["src/a.ts"], truncated: false };
  const done = (extra: unknown) => DoneMessage.safeParse({ run_id: PARENT, lease_generation: 1, ...(extra === undefined ? {} : { conflict_attest: extra }) });

  it("is optional and strict, and has no field that can hold content", () => {
    expect(done(undefined).success).toBe(true);
    expect(done(body).success).toBe(true);
    expect(Object.keys(ConflictAttestation.shape).sort()).toEqual(["base_sha", "from_sha", "head", "history", "parents", "pushed_by_round", "second_parent_on_default", "still_conflicting", "touched_paths", "truncated"]);
    expect(done({ ...body, diff: "x" }).success).toBe(false);
    expect(done({ ...body, message: "x" }).success).toBe(false);
  });

  it("holds every field to its closed set", () => {
    for (const bad of [{ history: "maybe" }, { still_conflicting: "perhaps" }, { pushed_by_round: "yes" }, { head: "nope" }, { parents: [] }, { parents: [FROM, BASE, HEAD] }, { touched_paths: ["/etc/passwd"] }, { touched_paths: ["a/../b"] }, { touched_paths: ["a", "a"] }, { truncated: null }]) {
      expect(done({ ...body, ...bad }).success).toBe(false);
    }
    expect(done({ ...body, touched_paths: Array.from({ length: MAX_CONFLICT_ATTEST_PATHS }, (_, n) => `f${n}.ts`) }).success).toBe(true);
    expect(done({ ...body, touched_paths: Array.from({ length: MAX_CONFLICT_ATTEST_PATHS + 1 }, (_, n) => `f${n}.ts`) }).success).toBe(false);
  });
});
