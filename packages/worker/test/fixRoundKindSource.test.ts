import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * D#6 RUNNER-CHECK-SKIP-NO-COMMIT: the signed `fix_round_kind` comes from a typed `fixRoundKind` input that only the cloud's own fix-round starts set: the check-fix start says `check_fix` (both of its
 * starts), the review/person fix start says `review_fix` and only when it is not a merge-conflict or renumber round. A runner skips its check on an unmoved tip for `review_fix` alone.
 */
const ROOT = join(__dirname, "../..");
const text = (p: string): string => readFileSync(join(ROOT, p), "utf8");

describe("the fixRoundKind input has two origins", () => {
  it("the check-fix start sets check_fix on both of its starts, and never review_fix", () => {
    const src = text("worker/src/checkFix.ts");
    expect(src.match(/fixRoundKind: "check_fix" as const/g)).toHaveLength(2);
    expect(src).not.toContain("review_fix");
  });

  it("the review fix start sets review_fix only for a round that is not a conflict or renumber round, and never check_fix", () => {
    const src = text("worker/src/advance.ts");
    expect(src.match(/fixRoundKind/g)).toHaveLength(1);
    expect(src).toContain('...(!conflict && !answered ? { fixRoundKind: "review_fix" as const } : {})');
    expect(src).not.toContain('"check_fix"');
  });
});
