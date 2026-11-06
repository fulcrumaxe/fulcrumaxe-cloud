import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { CHECK_JOB_MIN_PROTOCOL, CONFLICT_ATTEST_JOB_MIN_PROTOCOL, CURRENT_PROTOCOL_VERSION, SCOPE_JOB_MIN_PROTOCOL } from "../src/messages.js";
import { JobSchema, JobScopeSchema, MAX_JOB_SCOPE_ENTRIES, MAX_JOB_SCOPE_ENTRY_CHARS, SignedJobSchema } from "../src/job.js";
import { canonicalJson, signJob, verifyJob } from "../src/jobSignature.js";
import { sampleJob } from "./helpers/sampleJob.js";

// D#6 SCOPE-IN-JOB: the `scope` job key.
const SCOPE = ["packages/web/**", "src/a.ts", "src/*.test.ts", "app/(group)/[id]/page.tsx"];

describe("the scope job key", () => {
  it("is protocol 15, above every earlier gate, and the current version is at least it", () => {
    expect(SCOPE_JOB_MIN_PROTOCOL).toBe(15);
    expect(SCOPE_JOB_MIN_PROTOCOL).toBeGreaterThan(CONFLICT_ATTEST_JOB_MIN_PROTOCOL);
    expect(SCOPE_JOB_MIN_PROTOCOL).toBeGreaterThan(CHECK_JOB_MIN_PROTOCOL);
    expect(CURRENT_PROTOCOL_VERSION).toBeGreaterThanOrEqual(SCOPE_JOB_MIN_PROTOCOL);
  });

  it("round-trips through the strict job parse, in order and unchanged", () => {
    const parsed = JobSchema.parse(sampleJob({ scope: SCOPE }));
    expect(parsed.scope).toEqual(SCOPE);
    expect(SignedJobSchema.safeParse({ job: sampleJob({ scope: SCOPE }), signature: "A".repeat(86) }).success).toBe(true);
  });

  it("is a non-empty list of bounded strings from the Spec grammar's characters, and nothing else", () => {
    const ok = (scope: unknown) => JobSchema.safeParse(sampleJob({ scope })).success;
    // The caps are the Spec parser's own (1024 patterns after brace expansion, 512 characters), pinned as numbers so a loosened constant is seen.
    expect(MAX_JOB_SCOPE_ENTRIES).toBe(1024);
    expect(MAX_JOB_SCOPE_ENTRY_CHARS).toBe(512);
    expect(ok(["a"])).toBe(true);
    expect(ok(Array.from({ length: MAX_JOB_SCOPE_ENTRIES }, (_, n) => `f${n}.ts`))).toBe(true);
    expect(ok(["x".repeat(MAX_JOB_SCOPE_ENTRY_CHARS)])).toBe(true);
    for (const bad of [[], Array.from({ length: MAX_JOB_SCOPE_ENTRIES + 1 }, (_, n) => `f${n}.ts`), ["x".repeat(MAX_JOB_SCOPE_ENTRY_CHARS + 1)], [""], ["a b"], ["a\\b"], ["a\nb"], ["a?b"], [1], "src/a.ts", { 0: "a" }, null, [null]]) {
      expect(ok(bad), JSON.stringify(bad)?.slice(0, 40)).toBe(false);
    }
    expect(JobScopeSchema.safeParse(["a"]).success).toBe(true);
  });

  it("is strict on the job: a misspelt key is refused, so a runner that predates the field refuses a job that carries it", () => {
    expect(JobSchema.safeParse(sampleJob({ scopes: SCOPE })).success).toBe(false);
    const before = JobSchema.omit({ scope: true });
    expect(before.safeParse(sampleJob()).success).toBe(true);
    expect(before.safeParse(sampleJob({ scope: SCOPE })).success).toBe(false);
  });

  it("is omitted, never null, on every other job: their canonical JSON and signature do not change", () => {
    const plain = sampleJob();
    expect(canonicalJson(plain)).not.toContain("scope");
    expect(JobSchema.safeParse({ ...(plain as object), scope: null }).success).toBe(false);
    const { privateKey } = generateKeyPairSync("ed25519");
    const a = signJob(JobSchema.parse(plain), privateKey);
    const b = signJob(JobSchema.parse(JSON.parse(JSON.stringify(plain))), privateKey);
    expect(a.signature).toBe(b.signature);
  });

  it("is covered by the signature: changing, adding, removing or reordering an entry fails verification", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const job = JobSchema.parse(sampleJob({ scope: SCOPE }));
    const signed = signJob(job, privateKey);
    const keys = { [job.key_id]: publicKey };
    const opts = { now: new Date(job.issued_at) };
    expect(verifyJob(JSON.parse(JSON.stringify(signed)), keys, opts).scope).toEqual(SCOPE);
    const edit = (change: (scope: string[]) => void) => {
      const copy = JSON.parse(JSON.stringify(signed));
      change(copy.job.scope);
      return () => verifyJob(copy, keys, opts);
    };
    expect(edit((s) => { s[1] = "src/b.ts"; })).toThrow();
    expect(edit((s) => { s.push("**/x"); })).toThrow();
    expect(edit((s) => { s.pop(); })).toThrow();
    expect(edit((s) => { s.reverse(); })).toThrow();
    const stripped = JSON.parse(JSON.stringify(signed));
    delete stripped.job.scope;
    expect(() => verifyJob(stripped, keys, opts)).toThrow();
  });
});
