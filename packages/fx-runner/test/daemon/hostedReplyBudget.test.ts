import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HOSTED_CLAIM_REPLY_BUDGET_BYTES, HOSTED_RESPONSE_LIMIT_BYTES, MAX_CLAIM_REPLY_BYTES, claimReplyBytes, worstCaseClaimReplyBytes } from "@fulcrumaxe/runner-protocol";
import { largestSignedJob } from "../helpers/largestJob.js";
import { signedJob } from "../helpers/signedJob.js";

/**
 * The cloud's hosted budget against real jobs: the largest valid job needs a reply a hosted function cannot send, so the issuer refuses it
 * (`job_too_large`); an ordinary job is far under. The runner's own cap stays the larger of the two.
 */
describe("hosted claim reply budget", () => {
  it("the largest valid job's reply is over the hosted budget (and so over what a hosted function can send), while the runner still reads it", () => {
    const job = largestSignedJob();
    const size = worstCaseClaimReplyBytes(job, job.job.run_id);
    expect(size).toBeGreaterThan(HOSTED_RESPONSE_LIMIT_BYTES);
    expect(size).toBeGreaterThan(HOSTED_CLAIM_REPLY_BUDGET_BYTES);
    expect(size).toBeLessThanOrEqual(MAX_CLAIM_REPLY_BYTES);
  });

  it("an ordinary job is far under the budget", () => {
    const job = signedJob({ run_id: randomUUID() });
    expect(worstCaseClaimReplyBytes(job, job.job.run_id)).toBeLessThan(HOSTED_CLAIM_REPLY_BUDGET_BYTES / 10);
  });

  it("the worst-case figure is never below the size of a real reply carrying the same job", () => {
    const job = signedJob({ run_id: randomUUID() });
    const real = { signed_job: job, run_id: job.job.run_id, lease_generation: 3 };
    expect(worstCaseClaimReplyBytes(job, job.job.run_id)).toBeGreaterThan(claimReplyBytes(real));
  });
});
