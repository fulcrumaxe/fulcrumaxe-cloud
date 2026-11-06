import { describe, expect, it } from "vitest";
import { ClaimReply } from "@fulcrumaxe/runner-protocol";
import { COVERED, namesBoundTerm } from "../../../runner-protocol/test/helpers/claimReplyCovered.js";
import { largestSignedJob } from "../helpers/largestJob.js";

/**
 * D#6 RUNNER-REPLY-CAP: the bound in claimReplyBound.ts is only proved by the largest reply if that reply really fills every field the bound names a term for.
 * A term whose field the builder leaves out would still pass the size test (the bound just has room it never uses) while the bound was never tested against it.
 * COVERED (shared with the runner-protocol test that pins the list to the schema) says which paths name a term; each must be present and non-empty here.
 */

/** Paths the largest reply leaves out on purpose, each with the reason. A path that names a bound term never goes here. */
const ABSENT_ON_PURPOSE: Record<string, string> = {
  // the wake grant, the merge-order hint and the retry hint belong to other claim answers (idle, held back), not to a claimed job
  wake: "only on an idle claim answer",
  "wake.poll_s": "only on an idle claim answer",
  "wake.token": "only on an idle claim answer",
  "wake.transport": "only on an idle claim answer",
  merge_order: "only on a claim answer that holds a run back",
  retry_after: "only on an idle claim answer",
  // a job is a fresh run, a continuation, a review or a conflict round; the largest fresh job carries none of the others, and each is small and fixed
  "signed_job.job.continues": "a continuation job, small and fixed",
  "signed_job.job.continues.base_sha": "a continuation job, small and fixed",
  "signed_job.job.continues.branch": "a continuation job, small and fixed",
  "signed_job.job.continues.parent_run_id": "a continuation job, small and fixed",
  "signed_job.job.continues.pr_number": "a continuation job, small and fixed",
  "signed_job.job.continues.session_id": "a continuation job, small and fixed",
  "signed_job.job.review": "a review job, small and fixed",
  "signed_job.job.review.head_sha": "a review job, small and fixed",
  "signed_job.job.conflict_round": "a conflict-round job, small and fixed",
  "signed_job.job.conflict_round.from_sha": "a conflict-round job, small and fixed",
  "signed_job.job.conflict_round.base_sha": "a conflict-round job, small and fixed",
  "signed_job.job.conflict_round.base_ref": "a conflict-round job, small and fixed",
};

/** Every value a path names in `value`, walking through arrays; a missing step yields nothing. */
function valuesAt(value: unknown, segments: string[]): unknown[] {
  if (segments.length === 0) return [value];
  if (Array.isArray(value)) return value.flatMap((item) => valuesAt(item, segments));
  if (typeof value !== "object" || value === null) return [];
  const [head, ...rest] = segments as [string, ...string[]];
  return head in value ? valuesAt((value as Record<string, unknown>)[head], rest) : [];
}

function isFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

describe("the largest claim reply fills every field the reply bound names a term for", () => {
  const signed = largestSignedJob();
  const parsed = ClaimReply.parse({ signed_job: signed, run_id: signed.job.run_id, lease_generation: 2_147_483_647 });

  it("has every bound-term path present and non-empty, with no exemption", () => {
    const empty = Object.keys(COVERED)
      .filter((path) => namesBoundTerm(path))
      .filter((path) => {
        const found = valuesAt(parsed, path.split("."));
        return found.length === 0 || !found.every(isFilled);
      });
    expect(empty, `the largest reply leaves these bound-term fields out or empty: ${empty.join(", ")}; fill them in largestSignedJob (test/helpers/largestJob.ts)`).toEqual([]);
  });

  it("has every other covered path present, except the ones listed as absent on purpose", () => {
    const missing = Object.keys(COVERED)
      .filter((path) => !namesBoundTerm(path) && !(path in ABSENT_ON_PURPOSE))
      .filter((path) => valuesAt(parsed, path.split(".")).length === 0);
    expect(missing, `absent from the largest reply: ${missing.join(", ")}; fill them in largestSignedJob or list them in ABSENT_ON_PURPOSE with the reason`).toEqual([]);
  });

  it("keeps the absent-on-purpose list honest: each entry is a covered path, not a bound term, and really absent or null", () => {
    for (const path of Object.keys(ABSENT_ON_PURPOSE)) {
      expect(COVERED, path).toHaveProperty(path);
      expect(namesBoundTerm(path), `${path} names a bound term, so it must be filled, not exempt`).toBe(false);
      expect(valuesAt(parsed, path.split(".")).filter(isFilled), `${path} is filled; take it off the list`).toEqual([]);
    }
  });
});
