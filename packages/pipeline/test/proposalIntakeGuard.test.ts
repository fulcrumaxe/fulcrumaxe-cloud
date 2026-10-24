import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listSourceFiles } from "../../test-guard/src/sourceFiles.js";

/**
 * D#483 S4-b3 (S4b-10): the labelled CLAIMS and EVIDENCE blocks of a proposal's intake body are built by `proposalIntakeBody` and nowhere else, so
 * there is one string, one fence and one cap for that text. This fails the build when any other non-test file under apps/ or packages/ (code, SQL,
 * docs, config: every file git lists there) carries either label. Tests are left out: they assert on the body's exact bytes.
 *
 * The labels are spelled in pieces here so this file never matches itself.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SELF = "packages/pipeline/src/advance/proposalIntake.ts";
const SKIP_DIRS = ["node_modules", ".next", "dist", "coverage", ".git", "test", "tests", "e2e", "__tests__"];
const LABELS = new RegExp(`\\b(?:${["CLA", "IMS"].join("")}|${["EVID", "ENCE"].join("")}):`);
const isTest = (f: string) => /\.(?:test|spec)\./.test(path.basename(f));

const nonTestFiles = (): string[] => listSourceFiles(REPO_ROOT, ["apps", "packages"], SKIP_DIRS).filter((f) => !isTest(f));

describe("S4b-10: only proposalIntake.ts builds the intake's labelled blocks", () => {
  it("the matcher catches each label, and not a longer identifier that ends in one", () => {
    expect(LABELS.test(`parts.push(\`${"CLA"}IMS:\\n\`)`)).toBe(true);
    expect(LABELS.test(`"${"EVID"}ENCE:\\n"`)).toBe(true);
    expect(LABELS.test(`export const VALID_${"EVID"}ENCE: Evidence = {`)).toBe(false);
    expect(LABELS.test("claims: string[]")).toBe(false);
  });

  it("scans a non-zero number of files, including proposalIntake.ts, which carries both labels", () => {
    const files = nonTestFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(SELF);
    expect(LABELS.test(readFileSync(path.join(REPO_ROOT, SELF), "utf8"))).toBe(true);
  });

  it("no other file carries either label", () => {
    const offenders = nonTestFiles()
      .filter((f) => f !== SELF)
      .filter((f) => LABELS.test(readFileSync(path.join(REPO_ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
