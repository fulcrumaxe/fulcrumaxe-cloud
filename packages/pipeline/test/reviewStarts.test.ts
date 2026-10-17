import { describe, expect, it } from "vitest";
import { attemptBase, attemptOfKey, nextAttempt } from "../src/advance/attemptKeys.js";
import { fixKeyLikes, parseReviewKey, reviewKeyLikes, reviewStep } from "../src/advance/reviewStarts.js";
import { PARKED_STAGE_REGISTRY, REVIEW_PROGRESS_KINDS, UNREGISTERED_STAGES } from "../src/advance/stageRegistry.js";
import { RESERVATION_PAUSE_REASONS } from "../src/advance/reservationPauses.js";
import { WAITING_STAGE_POSITIONS } from "../src/advance/waitingStages.js";
import { STAGE_WORDS } from "../src/advance/stageWords.js";
import { likeToRegex } from "./helpers/likeToRegex.js";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const ITEM = "11111111-2222-4333-8444-555555555555";
const APPROVAL = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/** D#483 S5-k1d: the reviewer and fix-round keys, and the registry entries that resume them. */
describe("the reviewer run key", () => {
  it("the first ask keeps the key it always had; a later ask is `:s<n>` after everything else", () => {
    expect(reviewStep(HEAD, "code-reviewer")).toBe(`review:${HEAD}:code-reviewer`);
    expect(reviewStep(HEAD, "code-reviewer", 0, 0)).toBe(`review:${HEAD}:code-reviewer`);
    expect(reviewStep(HEAD, "code-reviewer", 0, 3)).toBe(`review:${HEAD}:code-reviewer:s3`);
    expect(reviewStep(HEAD, "security-reviewer", 2, 0)).toBe(`review:${HEAD}:security-reviewer:rr2`);
    expect(reviewStep(HEAD, "security-reviewer", 2, 3)).toBe(`review:${HEAD}:security-reviewer:rr2:s3`);
  });

  it("S5k1d-2: a re-review round and an attempt are different families; a round asked while an attempt is pending never reuses the attempt's key or number", () => {
    const keys = new Set<string>();
    for (const rereview of [0, 1, 2, 3]) for (const attempt of [0, 1, 2, 3]) keys.add(reviewStep(HEAD, "code-reviewer", rereview, attempt));
    expect(keys.size).toBe(16);
    // The attempts already used by round 0 do not count for round 1: its numbering is its own.
    const round0 = [reviewStep(HEAD, "code-reviewer", 0, 0), reviewStep(HEAD, "code-reviewer", 0, 1), reviewStep(HEAD, "code-reviewer", 0, 2)];
    expect(nextAttempt(`review:${HEAD}:code-reviewer:rr1`, round0)).toBe(0);
    expect(nextAttempt(`review:${HEAD}:code-reviewer`, [...round0, reviewStep(HEAD, "code-reviewer", 1, 5)])).toBe(3);
    // And `:rr1` is never read as an attempt, nor `:s1` as a round.
    expect(attemptOfKey(`review:${HEAD}:code-reviewer:rr1`)).toBe(0);
    expect(attemptOfKey(`review:${HEAD}:code-reviewer:s1`)).toBe(1);
    expect(attemptOfKey(`review:${HEAD}:code-reviewer:rr1:s4`)).toBe(4);
    expect(attemptBase(`review:${HEAD}:code-reviewer:rr1:s4`)).toBe(`review:${HEAD}:code-reviewer:rr1`);
  });

  it("an attempt is read through the placement generation and the note pin the worker adds after it", () => {
    expect(attemptOfKey(`review:${HEAD}:code-reviewer:s3:p1`)).toBe(3);
    expect(attemptOfKey(`fix:${HEAD}:${APPROVAL}:r1:s2:p2:n0123456789abcdef`)).toBe(2);
    expect(attemptBase(`fix:${HEAD}:${APPROVAL}:s2:p1`)).toBe(`fix:${HEAD}:${APPROVAL}`);
    // A key with a generation and no attempt is attempt 0, and its base is the bare key.
    expect(attemptOfKey(`review:${HEAD}:code-reviewer:p1`)).toBe(0);
    expect(attemptBase(`review:${HEAD}:code-reviewer:p1`)).toBe(`review:${HEAD}:code-reviewer`);
  });

  it("parseReviewKey reads the head, the role and the round through an attempt, a generation and a pin; anything else is null", () => {
    expect(parseReviewKey(`advance:${ITEM}:review:${HEAD}:code-reviewer`)).toEqual({ headSha: HEAD, role: "code-reviewer", rereview: 0 });
    expect(parseReviewKey(`advance:${ITEM}:review:${HEAD}:acceptance-tester:rr2:s7:p1:n0123456789abcdef`)).toEqual({ headSha: HEAD, role: "acceptance-tester", rereview: 2 });
    for (const bad of [`advance:${ITEM}:fix:${HEAD}:${APPROVAL}`, `advance:${ITEM}:review:nothead:code-reviewer`, `advance:${ITEM}:review:${HEAD}:`, `advance:${ITEM}:review:${HEAD}:Code`]) expect(parseReviewKey(bad), bad).toBeNull();
  });
});

describe("the SQL patterns of the keys", () => {
  it("the review pattern matches every reviewer key of the item's head and nothing else", () => {
    const likes = reviewKeyLikes(ITEM, HEAD);
    expect(likes).toHaveLength(1);
    const re = likeToRegex(likes[0]!);
    for (const k of [`advance:${ITEM}:review:${HEAD}:code-reviewer`, `advance:${ITEM}:review:${HEAD}:code-reviewer:rr1:s3`, `advance:${ITEM}:review:${HEAD}:debater:s2:p1`]) expect(re.test(k), k).toBe(true);
    for (const k of [`advance:${ITEM}:review:${OTHER}:code-reviewer`, `advance:00000000-0000-4000-8000-000000000000:review:${HEAD}:code-reviewer`, `advance:${ITEM}:fix:${HEAD}:${APPROVAL}`, `advance:${ITEM}:build:v1:${APPROVAL}`]) expect(re.test(k), k).toBe(false);
  });

  it("the fix pattern names the head and the approval: an earlier round's key (another head) or another approval's key does not match", () => {
    const re = likeToRegex(fixKeyLikes(ITEM, HEAD, APPROVAL)[0]!);
    for (const k of [`advance:${ITEM}:fix:${HEAD}:${APPROVAL}`, `advance:${ITEM}:fix:${HEAD}:${APPROVAL}:r1`, `advance:${ITEM}:fix:${HEAD}:${APPROVAL}:r1:s2:p1:n0123456789abcdef`]) expect(re.test(k), k).toBe(true);
    for (const k of [`advance:${ITEM}:fix:${OTHER}:${APPROVAL}`, `advance:${ITEM}:fix:${HEAD}:ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee`, `advance:${ITEM}:review:${HEAD}:code-reviewer`]) expect(re.test(k), k).toBe(false);
  });

  it("a head that is not a commit id gives no pattern, so nothing is matched on a malformed fact", () => {
    for (const bad of [null, "", "zz", "A".repeat(40), `${HEAD}%`, "a".repeat(41)]) {
      expect(reviewKeyLikes(ITEM, bad)).toEqual([]);
      expect(fixKeyLikes(ITEM, bad, APPROVAL)).toEqual([]);
    }
  });

  it("characters that mean something in a LIKE pattern are escaped in the item and the approval", () => {
    expect(reviewKeyLikes("a_b%c", HEAD)[0]).toContain("a\\_b\\%c");
    expect(fixKeyLikes(ITEM, HEAD, "x_y")[0]).toContain("x\\_y");
  });
});

describe("S5k1d-8: the registry entries for the review and the fix round", () => {
  const review = PARKED_STAGE_REGISTRY.review!;
  const fix = PARKED_STAGE_REGISTRY.fix_round!;

  it("both stages are registered and the allowlist lost them (the panel, the last one, left it in S5-k1e)", () => {
    expect(review).toBeDefined();
    expect(fix).toBeDefined();
    expect([...UNREGISTERED_STAGES]).toEqual([]);
  });

  it("they park at the positions the table lists, for the spend pauses only, under the build's approval, on a head", () => {
    for (const e of [review, fix]) {
      expect(e.itemStages).toEqual(WAITING_STAGE_POSITIONS[e.stage]);
      expect([...e.pauses]).toEqual([...RESERVATION_PAUSE_REASONS]);
      expect(e.approval).toEqual({ kind: "advance_work_item", from: "self" });
      expect(e.needsSpec).toBe(true);
      expect(e.respec).toBe(false);
      expect(e.headBound).toBe(true);
      expect(e.progressKinds).toBe(REVIEW_PROGRESS_KINDS);
    }
    expect(review.role).toBe("code-reviewer");
    expect(fix.role).toBe("executor");
  });

  it("a review expects reviewers that started beside the denied one; a fix round does not", () => {
    expect(review.startedRunsOk).toBe(true);
    expect(fix.startedRunsOk).not.toBe(true);
  });

  it("the stage words are the approved set, the same ones the card already uses", () => {
    expect(STAGE_WORDS.review).toBe("waiting for a review");
    expect(STAGE_WORDS.fix_round).toBe("waiting for a fix round");
  });

  it("the run keys come from the head, and the next attempt is one past the highest (through a round and a generation)", () => {
    expect(review.runKeyLikes(ITEM, APPROVAL, HEAD)).toEqual(reviewKeyLikes(ITEM, HEAD));
    expect(fix.runKeyLikes(ITEM, APPROVAL, HEAD)).toEqual(fixKeyLikes(ITEM, HEAD, APPROVAL));
    expect(review.runKeyLikes(ITEM, APPROVAL)).toEqual([]);
    const k = `advance:${ITEM}:review:${HEAD}:code-reviewer`;
    expect(review.nextAttempt([])).toBe(0);
    expect(review.nextAttempt([k])).toBe(1);
    expect(review.nextAttempt([k, `${k}:s1`, `${k}:rr2:s4:p1`, `advance:${ITEM}:review:${HEAD}:debater:s2`])).toBe(5);
    expect(fix.nextAttempt([`advance:${ITEM}:fix:${HEAD}:${APPROVAL}`, `advance:${ITEM}:fix:${HEAD}:${APPROVAL}:r1:s3`])).toBe(4);
  });

  it("the progress kinds are the facts a review or a fix round writes once it has moved on, and never the waiting fact", () => {
    for (const kind of ["review_started", "review_verdicts", "fix_round_started", "fix_round_refused", "fix_pushed_nothing", "fix_round_failed", "escalated", "merge_gate", "merged_by_gate", "stopped"]) expect(REVIEW_PROGRESS_KINDS).toContain(kind);
    expect(REVIEW_PROGRESS_KINDS).not.toContain("stage_waiting");
    expect(REVIEW_PROGRESS_KINDS).not.toContain("build_waiting");
    expect(REVIEW_PROGRESS_KINDS).not.toContain("pr_head_pushed");
  });

  it("pauseForDenial is the start's own mapping", () => {
    expect(review.pauseForDenial("work_item_cap_exceeded")).toBe("item_cap_reached");
    expect(fix.pauseForDenial("account_not_active")).toBeNull();
  });
});
