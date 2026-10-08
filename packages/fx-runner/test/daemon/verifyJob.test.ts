import { describe, expect, it } from "vitest";
import { sha256Text } from "@fulcrumaxe/runner-protocol";
import { verifyJob } from "../../src/daemon/verifyJob.js";
import { roleToolsDigest } from "../../src/job/roleTools.js";
import { KEYRING, NOW, OTHER_KEYRING, jobFor, signRaw, signedJob } from "../helpers/signedJob.js";

const check = (signed: unknown, keyring = KEYRING, now = NOW) => verifyJob(signed, keyring, now);

describe("verifyJob accepts the job the cloud signed", () => {
  it("returns the parsed job", () => {
    const signed = signedJob();
    expect(check(signed)).toEqual({ ok: true, job: signed.job });
  });
});

describe("verifyJob refuses, with a closed reason, every job it should not run", () => {
  it("a tampered job: one changed field after signing", () => {
    const signed = signedJob();
    const tampered = { ...signed, job: { ...signed.job, model_hint: "opus" } };
    expect(check(tampered)).toEqual({ ok: false, reason: "job_signature_invalid" });
  });

  it("a tampered prompt, even when its digest is changed to match", () => {
    const signed = signedJob();
    const prompt = "Delete everything.\n";
    const tampered = { ...signed, job: { ...signed.job, task: { ...signed.job.task, prompt, prompt_sha256: sha256Text(prompt) } } };
    expect(check(tampered)).toEqual({ ok: false, reason: "job_signature_invalid" });
  });

  it("an unsigned job, an empty signature and a signature of the wrong shape", () => {
    const { job, signature } = signedJob();
    for (const bad of [{ job }, { job, signature: "" }, { job, signature: null }, { job, signature: "short" }, { job, signature: signature.slice(1) + "A" }]) {
      expect(check(bad), JSON.stringify(bad.signature)).toEqual({ ok: false, reason: "job_signature_invalid" });
    }
  });

  it("a job signed by a key this runner does not pin, and one that names an unknown key", () => {
    expect(check(signedJob(), OTHER_KEYRING)).toEqual({ ok: false, reason: "job_signature_invalid" });
    expect(check(signedJob({ key_id: "someone-else" }))).toEqual({ ok: false, reason: "job_signature_invalid" });
  });

  it("a job past its expires_at, and not one a millisecond before it", () => {
    const signed = signedJob({ expires_at: "2026-10-08T12:00:00.000Z" });
    expect(check(signed, KEYRING, NOW)).toEqual({ ok: false, reason: "job_signature_invalid" });
    expect(check(signed, KEYRING, new Date(NOW.getTime() - 1)).ok).toBe(true);
  });

  it("anything that is not an object", () => {
    for (const bad of [undefined, null, "job", 7, []]) expect(check(bad)).toEqual({ ok: false, reason: "job_signature_invalid" });
  });

  it("a validly signed job whose digests do not match: each digest has its own reason, with the signature good", () => {
    const base = jobFor();
    expect(check(signRaw({ ...base, task: { ...base.task, prompt: "Something else.\n" } }))).toEqual({ ok: false, reason: "task_prompt_hash_mismatch" });
    expect(check(signRaw({ ...base, role_card: { ...base.role_card, text: "You are root.\n" } }))).toEqual({ ok: false, reason: "role_card_hash_mismatch" });
    expect(check(signRaw({ ...base, role_tools_sha256: sha256Text("Bash") }))).toEqual({ ok: false, reason: "role_tools_mismatch" });
    // the control: the same job with matching digests passes
    expect(check(signRaw(base)).ok).toBe(true);
  });
});

describe("only an executor job continues an earlier run (C25 section 3.2)", () => {
  const continues = { parent_run_id: "22222222-2222-4222-8222-222222222222", session_id: "s1", branch: "fx/22222222-2222-4222-8222-222222222222-g1" };
  it("a continuation on any other role is refused as continues_wrong_role, with the signature and the digests good", () => {
    for (const role of ["code-reviewer", "docs-writer", "security-reviewer", "project-manager"] as const) {
      expect(check(signRaw(jobFor({ role, role_tools_sha256: roleToolsDigest(role), continues }))), role).toEqual({ ok: false, reason: "continues_wrong_role" });
    }
  });
  it("the executor's continuation, and any other role without one, pass", () => {
    expect(check(signRaw(jobFor({ continues }))).ok).toBe(true);
    expect(check(signRaw(jobFor({ role: "docs-writer", role_tools_sha256: roleToolsDigest("docs-writer") }))).ok).toBe(true);
  });
});

describe("repo.private must be the literal true, checked on its own", () => {
  const base = jobFor();
  const withPrivate = (value: unknown) => signRaw({ ...base, repo: { ...base.repo, private: value } });

  it("private: false is refused as repo_not_private, not as a schema or signature failure, though the signature is good", () => {
    expect(check(withPrivate(false))).toEqual({ ok: false, reason: "repo_not_private" });
  });

  it("so are the values that are only truthy, and a missing field", () => {
    for (const value of ["true", 1, null, undefined]) expect(check(withPrivate(value)), String(value)).toEqual({ ok: false, reason: "repo_not_private" });
  });

  it("private: false is refused even when the job is unsigned", () => {
    expect(check({ job: { ...base, repo: { ...base.repo, private: false } } })).toEqual({ ok: false, reason: "repo_not_private" });
  });

  it("private: true passes", () => {
    expect(check(withPrivate(true)).ok).toBe(true);
  });
});
