import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CONTINUES_CROSS_SIDE_MIN_PROTOCOL, CURRENT_PROTOCOL_VERSION, HANDOFF_MIN_PROTOCOL_VERSION } from "../src/messages.js";
import { SESSION_ID_PATTERN } from "../src/job.js";
import { ITEM_PR_BRANCH, JOB_CLASS_BY_ROLE, JOB_MODES, REVIEW_JOB_ROLES, jobClassOfRole, JobSchema, MAX_ROLE_CARD_CHARS, RUNNER_ELIGIBLE_ROLES, SignedJobSchema, TASK_KINDS, jobDigestMismatches, sha256Text } from "../src/job.js";
import { sampleJob } from "./helpers/sampleJob.js";

/** `continues` is an object with a refinement (D#599 PL-2b), so its keys sit one wrapper down. */
const continuesObject = () => (JobSchema.shape.continues.unwrap() as unknown as z.ZodEffects<z.AnyZodObject>).innerType();

const RUN_BRANCH = "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1";

describe("job schema", () => {
  it("has exactly the Spec's top-level keys", () => {
    expect(Object.keys(JobSchema.shape).sort()).toEqual(
      [
        "schema_version", "job_id", "run_id", "repo", "role", "mode", "spec", "task", "role_card", "role_tools_sha256", "continues",
        "branch_prefix", "model_hint", "issued_at", "expires_at", "key_id", "review", "sandbox_allowances", "requires_engine",
      ].sort(),
    );
    expect(Object.keys(JobSchema.shape.repo.shape).sort()).toEqual(["id", "name", "owner", "private"]);
    expect(Object.keys(JobSchema.shape.spec.unwrap().shape).sort()).toEqual(["discussion", "sha256", "text", "version"]);
    expect(Object.keys(JobSchema.shape.task.shape).sort()).toEqual(["kind", "prompt", "prompt_sha256"]);
    expect(Object.keys(JobSchema.shape.role_card.shape).sort()).toEqual(["sha256", "text"]);
    expect(Object.keys(continuesObject().shape).sort()).toEqual(["branch", "parent_run_id", "pr_number", "session_id"]);
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
      if (schema instanceof z.ZodEffects) return walk(schema.innerType(), path);
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
    expect(ok({ parent_run_id: parent, session_id: "7f0c1d2e-aaaa-bbbb-cccc-0123456789ab", branch: RUN_BRANCH })).toBe(true);
    expect(ok(undefined)).toBe(false);
    expect(ok({ parent_run_id: "not-a-uuid", session_id: "s", branch: "fx/a" })).toBe(false);
    for (const session_id of ["", "a b", "s;rm -rf /", "x".repeat(129)]) expect(ok({ parent_run_id: parent, session_id, branch: "fx/a" }), session_id).toBe(false);
    for (const branch of ["", "../x", "fx/../x", "/abs", "fx//a", "a b", "https://example.test/x", "x".repeat(201)]) expect(ok({ parent_run_id: parent, session_id: "s", branch }), branch).toBe(false);
  });

  describe("continues across sides (D#599 PL-2b-1)", () => {
    const parent = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5f";
    const ok = (c: unknown) => JobSchema.safeParse(sampleJob({ continues: c })).success;

    it.each([
      ["a null session id on a run branch", { parent_run_id: parent, session_id: null, branch: RUN_BRANCH }, true],
      ["a session id on a run branch", { parent_run_id: parent, session_id: "s-1", branch: RUN_BRANCH }, true],
      ["the item pull request branch with its number and no session", { parent_run_id: parent, session_id: null, branch: "fx/issue-12", pr_number: 7 }, true],
      ["the item pull request branch without a number", { parent_run_id: parent, session_id: null, branch: "fx/issue-12" }, false],
      ["the item pull request branch with a session id", { parent_run_id: parent, session_id: "s-1", branch: "fx/issue-12", pr_number: 7 }, false],
      ["a run branch with a number", { parent_run_id: parent, session_id: null, branch: RUN_BRANCH, pr_number: 7 }, false],
      ["main with a number", { parent_run_id: parent, session_id: null, branch: "main", pr_number: 7 }, false],
      ["main without a number", { parent_run_id: parent, session_id: null, branch: "main" }, false],
      ["main with a session id", { parent_run_id: parent, session_id: "s-1", branch: "main" }, false],
      ["fx/issue-0 without a number", { parent_run_id: parent, session_id: null, branch: "fx/issue-0" }, false],
      ["fx/issue-12/x without a number", { parent_run_id: parent, session_id: null, branch: "fx/issue-12/x" }, false],
      ["fx/issues-12 without a number", { parent_run_id: parent, session_id: null, branch: "fx/issues-12" }, false],
      ["refs/heads/fx/issue-12 without a number", { parent_run_id: parent, session_id: null, branch: "refs/heads/fx/issue-12" }, false],
      ["a run branch with a zero generation", { parent_run_id: parent, session_id: "s-1", branch: "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g0" }, false],
      ["fx/issue-0 (not an item branch, so no number allowed)", { parent_run_id: parent, session_id: null, branch: "fx/issue-0", pr_number: 7 }, false],
      ["fx/issue-12/x with a number", { parent_run_id: parent, session_id: null, branch: "fx/issue-12/x", pr_number: 7 }, false],
      ["fx/issues-12 with a number", { parent_run_id: parent, session_id: null, branch: "fx/issues-12", pr_number: 7 }, false],
      ["refs/heads/fx/issue-12 with a number", { parent_run_id: parent, session_id: null, branch: "refs/heads/fx/issue-12", pr_number: 7 }, false],
      ["a number of 0", { parent_run_id: parent, session_id: null, branch: "fx/issue-12", pr_number: 0 }, false],
      ["a number above the integer range", { parent_run_id: parent, session_id: null, branch: "fx/issue-12", pr_number: 2 ** 31 }, false],
      ["the largest number", { parent_run_id: parent, session_id: null, branch: "fx/issue-12", pr_number: 2 ** 31 - 1 }, true],
      ["a null number", { parent_run_id: parent, session_id: null, branch: "fx/issue-12", pr_number: null }, false],
    ] as const)("%s", (_name, continues, expected) => {
      // The schema narrows the branch to a run branch or the item's pull request branch (ruling R-599-PL2b-1-a), with or without a number.
      expect(ok(continues)).toBe(expected);
    });

    it("pins ITEM_PR_BRANCH to fx/issue-<n> with n of 1 to 10 digits and no leading zero", () => {
      for (const good of ["fx/issue-1", "fx/issue-12", "fx/issue-9999999999"]) expect(ITEM_PR_BRANCH.test(good), good).toBe(true);
      for (const bad of ["fx/issue-0", "fx/issue-07", "fx/issue-12/x", "fx/issues-12", "fx/issue-12 ", "refs/heads/fx/issue-12", "fx/issue-", "fx/issue-12345678901", "main", "fx/docs/x", "xfx/issue-12"]) expect(ITEM_PR_BRANCH.test(bad), bad).toBe(false);
    });

    it("refuses a job with a null session id on a runner whose parse predates the field (why the cloud gates the claim)", () => {
      // A pinned copy of the strict `continues` before PL-2b: the session id was always a string and no pull request number existed.
      const before = z.object({ parent_run_id: z.string().uuid(), session_id: z.string().regex(SESSION_ID_PATTERN), branch: z.string() }).strict().nullable();
      const previousJob = JobSchema.extend({ continues: before });
      const nullSession = sampleJob({ continues: { parent_run_id: parent, session_id: null, branch: RUN_BRANCH } });
      const withNumber = sampleJob({ continues: { parent_run_id: parent, session_id: null, branch: "fx/issue-12", pr_number: 7 } });
      expect(previousJob.safeParse(sampleJob({ continues: { parent_run_id: parent, session_id: "s-1", branch: RUN_BRANCH } })).success).toBe(true);
      expect(previousJob.safeParse(nullSession).success).toBe(false);
      expect(previousJob.safeParse(withNumber).success).toBe(false);
      expect(JobSchema.safeParse(nullSession).success).toBe(true);
      expect(JobSchema.safeParse(withNumber).success).toBe(true);
    });

    it("sets the cross-side protocol floor one above the handoff version, and leaves the hello floor alone", () => {
      expect(CONTINUES_CROSS_SIDE_MIN_PROTOCOL).toBe(HANDOFF_MIN_PROTOCOL_VERSION + 1);
      // Until the runner release (PL-2b-3) raises the current version, no runner can claim a gated job, and none is cut off for it.
      expect(CONTINUES_CROSS_SIDE_MIN_PROTOCOL).toBeGreaterThanOrEqual(CURRENT_PROTOCOL_VERSION);
    });
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

describe("job.review (D#6 R4d-4a, C33)", () => {
  const reviewJob = (review: unknown, role = "code-reviewer"): unknown => sampleJob({ role, task: { ...(sampleJob() as { task: object }).task, kind: "review" }, review });
  const SHA40 = "0123456789abcdef0123456789abcdef01234567";
  const SHA64 = "0123456789abcdef".repeat(4);

  it("C43-2a: JOB_CLASS_BY_ROLE maps exactly the runner-eligible roles", () => {
    expect(Object.keys(JOB_CLASS_BY_ROLE).sort()).toEqual([...RUNNER_ELIGIBLE_ROLES].sort());
  });

  it("C43-2a: executor and acceptance-tester are heavy, the other eleven are light, an unknown role is heavy", () => {
    const heavy = RUNNER_ELIGIBLE_ROLES.filter((r) => jobClassOfRole(r) === "heavy");
    expect([...heavy].sort()).toEqual(["acceptance-tester", "executor"]);
    expect(RUNNER_ELIGIBLE_ROLES.filter((r) => jobClassOfRole(r) === "light")).toHaveLength(11);
    for (const role of ["", "made-up", "toString", "__proto__", "constructor"]) expect(jobClassOfRole(role), role).toBe("heavy");
  });

  it("REVIEW_JOB_ROLES is the four review roles, all runner eligible", () => {
    expect([...REVIEW_JOB_ROLES]).toEqual(["code-reviewer", "security-reviewer", "acceptance-tester", "debater"]);
    for (const role of REVIEW_JOB_ROLES) expect((RUNNER_ELIGIBLE_ROLES as readonly string[]).includes(role)).toBe(true);
  });

  it.each(REVIEW_JOB_ROLES)("G1: %s job accepts review.head_sha of 40 and of 64 lowercase hex", (role) => {
    expect(JobSchema.safeParse(reviewJob({ head_sha: SHA40 }, role)).success).toBe(true);
    expect(JobSchema.safeParse(reviewJob({ head_sha: SHA64 }, role)).success).toBe(true);
  });

  it("G1: refuses an uppercase, short, long, odd-length or non-hex head_sha, an extra key inside review, an empty review and review: null", () => {
    for (const bad of [SHA40.toUpperCase(), SHA40.slice(1), SHA40 + "a", SHA64 + "a", "g".repeat(40), "", "a".repeat(41), "a".repeat(63)]) {
      expect(JobSchema.safeParse(reviewJob({ head_sha: bad })).success, bad).toBe(false);
    }
    expect(JobSchema.safeParse(reviewJob({ head_sha: SHA40, base_sha: SHA40 })).success).toBe(false);
    expect(JobSchema.safeParse(reviewJob({ head_sha: SHA40, branch: "fx/a" })).success).toBe(false);
    expect(JobSchema.safeParse(reviewJob({})).success).toBe(false);
    expect(JobSchema.safeParse(reviewJob(null)).success).toBe(false);
  });

  it("a job without the key still parses, and the parsed job has no review key", () => {
    const parsed = JobSchema.parse(sampleJob());
    expect("review" in parsed).toBe(false);
  });
});

describe("job.sandbox_allowances (D#6 R7a, C35)", () => {
  const entry = { kind: "domain", value: "registry.npmjs.org", access: "connect", reason: "pnpm install --frozen-lockfile fetches the locked packages" };
  const withAllowances = (over: Record<string, unknown> = {}) => sampleJob({ sandbox_allowances: { entries: [entry], command_timeout_s: 900, ...over } });

  it("accepts a set with entries and a timeout, and the parsed job carries it", () => {
    expect(JobSchema.parse(withAllowances()).sandbox_allowances).toEqual({ entries: [entry], command_timeout_s: 900 });
  });

  it("is omitted, never null or empty, on a job without allowances", () => {
    expect("sandbox_allowances" in JobSchema.parse(sampleJob())).toBe(false);
    expect(JobSchema.safeParse(sampleJob({ sandbox_allowances: null })).success).toBe(false);
    expect(JobSchema.safeParse(withAllowances({ entries: [] })).success).toBe(false);
  });

  it("refuses a missing, zero, fractional or over-long timeout, an extra key, an unknown kind or access, and more than 64 entries", () => {
    expect(JobSchema.safeParse(sampleJob({ sandbox_allowances: { entries: [entry] } })).success).toBe(false);
    for (const bad of [0, -1, 1.5, 1801, "900", null]) expect(JobSchema.safeParse(withAllowances({ command_timeout_s: bad })).success, String(bad)).toBe(false);
    expect(JobSchema.safeParse(withAllowances({ command_timeout_s: 1800 })).success).toBe(true);
    expect(JobSchema.safeParse(withAllowances({ extra: 1 })).success).toBe(false);
    expect(JobSchema.safeParse(withAllowances({ entries: [{ ...entry, extra: 1 }] })).success).toBe(false);
    expect(JobSchema.safeParse(withAllowances({ entries: [{ ...entry, kind: "socket" }] })).success).toBe(false);
    expect(JobSchema.safeParse(withAllowances({ entries: [{ ...entry, access: "execute" }] })).success).toBe(false);
    expect(JobSchema.safeParse(withAllowances({ entries: Array.from({ length: 65 }, (_, i) => ({ ...entry, value: `h${i}.example.com` })) })).success).toBe(false);
  });

  it("refuses a reason with a control character or a line break, and an empty or over-long value", () => {
    for (const reason of ["two\nlines", "bell\u0007", ""]) expect(JobSchema.safeParse(withAllowances({ entries: [{ ...entry, reason }] })).success, JSON.stringify(reason)).toBe(false);
    for (const value of ["", "has space.example.com", "x".repeat(513)]) expect(JobSchema.safeParse(withAllowances({ entries: [{ ...entry, value }] })).success, value.slice(0, 20)).toBe(false);
  });
});

describe("job.requires_engine (D#605 FL-4)", () => {
  it("accepts microvm, and the parsed job carries it", () => {
    expect(JobSchema.parse(sampleJob({ requires_engine: "microvm" })).requires_engine).toBe("microvm");
  });

  it("is omitted, never null, on a job that needs no VM, so every other job's canonical JSON is unchanged", () => {
    expect("requires_engine" in JobSchema.parse(sampleJob())).toBe(false);
    expect(JobSchema.safeParse(sampleJob({ requires_engine: null })).success).toBe(false);
  });

  it("refuses any other value, including os_sandbox: a job can require a VM, never forbid one", () => {
    for (const bad of ["os_sandbox", "docker", "", 1, true]) expect(JobSchema.safeParse(sampleJob({ requires_engine: bad })).success, String(bad)).toBe(false);
  });
});
