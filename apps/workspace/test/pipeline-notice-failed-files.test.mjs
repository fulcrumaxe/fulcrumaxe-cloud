// apps/workspace/test/pipeline-notice-failed-files.test.mjs
//
// D#6 CHECK-FAILURE-NAMES-ON-CARD: the needs-a-person banner carries the failing test files (and each one's Run: hint) the server sent,
// drawn as data. A malformed list draws nothing and never hides the sentence.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { noticeBanner, noticeFailedFiles, NOTICE_FAILED_FILES_LABEL, NOTICE_FAILED_FILES_MORE } from "../apps/pipeline/pipeline-insight.js";
import { checkView } from "../apps/runs/runs-detail.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "..", "..", "..", "packages", "api", "fixtures", "v1", "getWorkItemActivity", "200-needs-human-check-outside-change.json"), "utf8"));

describe("noticeBanner: failing files on the outside-only stop", () => {
  it("carries the files, their hints and the cut count from the contract fixture", () => {
    const b = noticeBanner(fixture);
    expect(b.kind).toBe("needs_human");
    expect(b.reason).toContain("this change didn't touch");
    expect(b.files).toEqual([{ name: "apps/ops/test/scan.test.ts" }, { name: "packages/api-client/test/drift.test.ts", hint: "pnpm --filter @fx/api-client gen" }]);
    expect(b.filesMore).toBe(3);
    expect(NOTICE_FAILED_FILES_LABEL).toBe("Failing test files:");
    expect(NOTICE_FAILED_FILES_MORE(3)).toBe("+3 more");
  });

  it("draws nothing extra for a notice without a list, or with a malformed one", () => {
    expect(noticeBanner({ notice: { kind: "needs_human", reason: "x" } }).files).toBeUndefined();
    for (const bad of [[], [{ name: 5 }], [{ name: "a", hint: 7 }], [null], Array.from({ length: 21 }, (_, n) => ({ name: "f" + n })), "apps/a"]) {
      expect(noticeFailedFiles({ failed_files: bad })).toEqual({});
    }
    expect(noticeBanner({ notice: { kind: "needs_human", reason: "x", failed_files: [{ name: 5 }] } })).toMatchObject({ reason: "x" });
  });
});

describe("runs detail: a failing file's hint", () => {
  it("is kept per file, only for strings", () => {
    const base = JSON.parse(readFileSync(join(here, "..", "..", "..", "packages", "api", "fixtures", "v1", "getRunInsight", "200-check-failed-files.json"), "utf8"));
    const body = { ...base, check: { ...base.check, result: { ...base.check.result, failed_files: ["a.test.ts", "b.test.ts"], failed_file_hints: [{ file: "a.test.ts", hint: "pnpm gen" }, { file: "b.test.ts", hint: 5 }, null] } } };
    const failed = checkView(body).failed;
    expect([...failed.hints]).toEqual([["a.test.ts", "pnpm gen"]]);
  });
});
