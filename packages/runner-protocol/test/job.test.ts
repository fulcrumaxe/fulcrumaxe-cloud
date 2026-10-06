import { describe, expect, it } from "vitest";
import { z } from "zod";
import { JOB_MODES, JobSchema, MAX_ROLE_CARD_CHARS, RUNNER_ELIGIBLE_ROLES, SignedJobSchema, TASK_KINDS, jobDigestMismatches, sha256Text } from "../src/job.js";
import { sampleJob } from "./helpers/sampleJob.js";

describe("job schema", () => {
  it("has exactly the Spec's top-level keys", () => {
    expect(Object.keys(JobSchema.shape).sort()).toEqual(
      [
        "schema_version", "job_id", "run_id", "repo", "role", "mode", "spec", "task", "role_card", "role_tools_sha256", "continues",
        "branch_prefix", "model_hint", "issued_at", "expires_at", "key_id",
      ].sort(),
    );
    expect(Object.keys(JobSchema.shape.repo.shape).sort()).toEqual(["id", "name", "owner", "private"]);
    expect(Object.keys(JobSchema.shape.spec.unwrap().shape).sort()).toEqual(["discussion", "sha256", "text", "version"]);
    expect(Object.keys(JobSchema.shape.task.shape).sort()).toEqual(["kind", "prompt", "prompt_sha256"]);
    expect(Object.keys(JobSchema.shape.role_card.shape).sort()).toEqual(["sha256", "text"]);
    expect(Object.keys(JobSchema.shape.continues.unwrap().shape).sort()).toEqual(["branch", "parent_run_id", "session_id"]);
  });

  it("accepts a well-formed job", () => {
    expect(JobSchema.safeParse(sampleJob()).success).toBe(true);
  });

  it("rejects an unknown key at every level", () => {
    expect(JobSchema.safeParse(sampleJob({ extra: 1 })).success).toBe(false);
    expect(JobSchema.safeParse(sampleJob({ repo: { id: "3c1e5a7b-2d4f-4a6c-8e0b-1a2b3c4d5e6f", owner: "a", name: "b", private: true, x: 1 } })).success).toBe(false);
    expect(JobSchema.safeParse(sampleJob({ spec: { discussion: 1, version: 1, sha256: "a".repeat(64), text: "", x: 1 } })).success).toBe(false);
    expect(JobSchema.safeParse(sampleJob({ task: { kind: "implement", prompt: "", prompt_sha256: sha256Text(""), x: 1 } })).success).toBe(false);
    expect(JobSchema.safeParse(sampleJob({ role_card: { text: "c", sha256: sha256Text("c"), x: 1 } })).success).toBe(false);
    expect(JobSchema.safeParse(sampleJob({ continues: { parent_run_id: "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5f", session_id: "s", branch: "fx/a", x: 1 } })).success).toBe(false);
  });

  it("has no field for a command, a URL, an image, a binary reference, an environment map or a settings object", () => {
    for (const key of ["command", "cmd", "url", "image", "binary", "env", "settings", "args", "script", "path"]) {
      expect(JobSchema.safeParse(sampleJob({ [key]: key === "env" || key === "settings" ? { A: "b" } : "x" })).success, key).toBe(false);
    }
    // Structurally: the only free-form strings are spec.text, task.prompt and role_card.text, and no field is an open record, a union or an unknown.
    const freeText: string[] = [];
    const walk = (schema: z.ZodTypeAny, path: string): void => {
      if (schema instanceof z.ZodObject) {
        expect(schema._def.unknownKeys, path).toBe("strict");
        for (const [key, child] of Object.entries(schema.shape)) walk(child as z.ZodTypeAny, `${path}.${key}`);
        return;
      }
      if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional) return walk(schema.unwrap(), path);
      expect(schema instanceof z.ZodRecord || schema instanceof z.ZodAny || schema instanceof z.ZodUnknown || schema instanceof z.ZodUnion, path).toBe(false);
      if (schema instanceof z.ZodString && !schema._def.checks.some((c) => c.kind === "regex" || c.kind === "uuid" || c.kind === "datetime")) freeText.push(path);
    };
    walk(JobSchema, "job");
    expect(freeText).toEqual(["job.spec.text", "job.task.prompt", "job.role_card.text"]);
  });

  it("refuses a URL, a path or a command where a bounded identifier is expected", () => {
    for (const bad of ["https://example.test/x/", "../x/", "fx/;rm -rf /;/", "fx//", "fx/a b/"]) {
      expect(JobSchema.safeParse(sampleJob({ branch_prefix: bad })).success, bad).toBe(false);
    }
    for (const bad of ["https://example.test/m", "m; ls", "a b"]) {
      expect(JobSchema.safeParse(sampleJob({ model_hint: bad })).success, bad).toBe(false);
    }
    for (const bad of ["acme/evil", "-acme", "ac me"]) {
      expect(JobSchema.safeParse(sampleJob({ repo: { id: "3c1e5a7b-2d4f-4a6c-8e0b-1a2b3c4d5e6f", owner: bad, name: "w", private: true } })).success, bad).toBe(false);
    }
  });

  it("limits role to the runner-eligible roles, and mode to local or verified", () => {
    expect([...JOB_MODES]).toEqual(["local", "verified"]);
    for (const role of RUNNER_ELIGIBLE_ROLES) expect(JobSchema.safeParse(sampleJob({ role })).success, role).toBe(true);
    // C12 section 1 (the owner ruling): the four reviewers are runner-eligible.
    for (const role of ["code-reviewer", "security-reviewer", "acceptance-tester", "debater"]) expect(RUNNER_ELIGIBLE_ROLES).toContain(role);
    expect(RUNNER_ELIGIBLE_ROLES).toHaveLength(13);
    for (const role of ["researcher", "browser-tester", "root", ""]) {
      expect(JobSchema.safeParse(sampleJob({ role })).success, role).toBe(false);
    }
    expect(JobSchema.safeParse(sampleJob({ mode: "remote" })).success).toBe(false);
  });

  it("carries no credential_mode: the runner knows its own mode from its registration (A2), and the strict schema refuses one", () => {
    expect(Object.keys(JobSchema.shape)).not.toContain("credential_mode");
    expect(JobSchema.safeParse(sampleJob({ credential_mode: "subscription" })).success).toBe(false);
  });

  it("spec is nullable: a run with no Spec is a valid job", () => {
    expect(JobSchema.safeParse(sampleJob({ spec: null })).success).toBe(true);
    for (const bad of [undefined, {}, "", 0]) expect(JobSchema.safeParse(sampleJob({ spec: bad })).success, String(bad)).toBe(false);
  });

  it("repo.private is the literal true: a job for a public repo does not parse", () => {
    const repo = (isPrivate: unknown) => ({ id: "3c1e5a7b-2d4f-4a6c-8e0b-1a2b3c4d5e6f", owner: "acme", name: "widgets", private: isPrivate });
    expect(JobSchema.safeParse(sampleJob({ repo: repo(true) })).success).toBe(true);
    for (const bad of [false, "true", 1, null, undefined]) expect(JobSchema.safeParse(sampleJob({ repo: repo(bad) })).success, String(bad)).toBe(false);
  });

  it("task.kind is closed, and task and role_card are required", () => {
    expect([...TASK_KINDS]).toEqual(["implement", "fix", "review", "advise"]);
    for (const kind of TASK_KINDS) expect(JobSchema.safeParse(sampleJob({ task: { kind, prompt: "p", prompt_sha256: sha256Text("p") } })).success, kind).toBe(true);
    for (const kind of ["", "exec", "IMPLEMENT"]) expect(JobSchema.safeParse(sampleJob({ task: { kind, prompt: "p", prompt_sha256: sha256Text("p") } })).success, kind).toBe(false);
    expect(JobSchema.safeParse(sampleJob({ task: undefined })).success).toBe(false);
    expect(JobSchema.safeParse(sampleJob({ role_card: undefined })).success).toBe(false);
    expect(JobSchema.safeParse(sampleJob({ role_card: { text: "", sha256: sha256Text("") } })).success).toBe(false);
    expect(JobSchema.safeParse(sampleJob({ role_card: { text: "x".repeat(MAX_ROLE_CARD_CHARS + 1), sha256: sha256Text("x") } })).success).toBe(false);
  });

  it("digests are 64 lowercase hex characters", () => {
    for (const bad of ["", "A".repeat(64), "a".repeat(63), "g".repeat(64)]) {
      expect(JobSchema.safeParse(sampleJob({ role_tools_sha256: bad })).success, bad).toBe(false);
      expect(JobSchema.safeParse(sampleJob({ task: { kind: "review", prompt: "p", prompt_sha256: bad } })).success, bad).toBe(false);
    }
    expect(JobSchema.safeParse(sampleJob({ role_tools_sha256: undefined })).success).toBe(false);
  });

  it("continues is null or a parent run, a bounded session id and a plain branch name", () => {
    const parent = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5f";
    const ok = (c: unknown) => JobSchema.safeParse(sampleJob({ continues: c })).success;
    expect(ok(null)).toBe(true);
    expect(ok({ parent_run_id: parent, session_id: "7f0c1d2e-aaaa-bbbb-cccc-0123456789ab", branch: "fx/issue-12" })).toBe(true);
    expect(ok(undefined)).toBe(false);
    expect(ok({ parent_run_id: "not-a-uuid", session_id: "s", branch: "fx/a" })).toBe(false);
    for (const session_id of ["", "a b", "s;rm -rf /", "x".repeat(129)]) expect(ok({ parent_run_id: parent, session_id, branch: "fx/a" }), session_id).toBe(false);
    for (const branch of ["", "../x", "fx/../x", "/abs", "fx//a", "a b", "https://example.test/x", "x".repeat(201)]) expect(ok({ parent_run_id: parent, session_id: "s", branch }), branch).toBe(false);
  });

  it("jobDigestMismatches names a digest that does not match its text", () => {
    const job = JobSchema.parse(sampleJob());
    expect(jobDigestMismatches(job)).toEqual([]);
    expect(jobDigestMismatches({ ...job, task: { ...job.task, prompt: `${job.task.prompt}!` } })).toEqual(["task.prompt_sha256"]);
    expect(jobDigestMismatches({ ...job, role_card: { ...job.role_card, text: `${job.role_card.text}!` } })).toEqual(["role_card.sha256"]);
    expect(sha256Text("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("a signed job wraps the job and one signature, and nothing else", () => {
    expect(Object.keys(SignedJobSchema.shape).sort()).toEqual(["job", "signature"]);
  });
});
