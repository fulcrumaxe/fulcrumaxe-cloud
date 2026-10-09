import { describe, expect, it } from "vitest";
import { verifyJob } from "../../src/daemon/verifyJob.js";
import { roleToolsDigest } from "../../src/job/roleTools.js";
import { KEYRING, NOW, jobFor, signRaw, signedJob } from "../helpers/signedJob.js";

const check = (signed: unknown) => verifyJob(signed, KEYRING, NOW);

// D#6 R4d-4b (C33 H1): a review role's job names the commit to review, and no other role's job does.
describe("H1: review.head_sha is required on a review role and refused on every other", () => {
  const REVIEW_ROLES = ["code-reviewer", "security-reviewer", "acceptance-tester", "debater"] as const;
  const review = { head_sha: "a".repeat(40) };
  for (const role of REVIEW_ROLES) {
    it(`${role}: without review.head_sha it is review_sha_missing, with a good signature and good digests`, () => {
      const base = { role, role_tools_sha256: roleToolsDigest(role) };
      expect(check(signRaw(jobFor(base))), role).toEqual({ ok: false, reason: "review_sha_missing" });
      expect(check(signRaw(jobFor({ ...base, review }))).ok, `${role} control`).toBe(true);
    });
  }

  it("an executor job carrying review is review_wrong_role (the control, without it, passes)", () => {
    expect(check(signRaw(jobFor({ review })))).toEqual({ ok: false, reason: "review_wrong_role" });
    expect(check(signRaw(jobFor())).ok).toBe(true);
  });

  it("so is every other non-review role", () => {
    for (const role of ["docs-writer", "project-manager"] as const) {
      expect(check(signRaw(jobFor({ role, role_tools_sha256: roleToolsDigest(role), review }))), role).toEqual({ ok: false, reason: "review_wrong_role" });
    }
  });

  it("the review key is covered by the signature: changing the sha after signing is job_signature_invalid", () => {
    const signed = signedJob({ role: "code-reviewer", role_tools_sha256: roleToolsDigest("code-reviewer"), review });
    const tampered = { ...signed, job: { ...signed.job, review: { head_sha: "b".repeat(40) } } };
    expect(check(tampered)).toEqual({ ok: false, reason: "job_signature_invalid" });
  });
});
