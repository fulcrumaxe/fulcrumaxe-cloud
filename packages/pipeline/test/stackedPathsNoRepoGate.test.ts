import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * D#598 C1 section 2 item 1 (static scan), for P3b: the stacked start and the stacked gate stop name no repository, no `code_repo`, no pairing, no plan
 * and no account list. The same code runs for every connected repository.
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/** Code only: comments may say what the path does not do. */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/.*$/, ""))
    .join("\n");
}

/** The text between two markers of a file, comments removed. */
function between(source: string, from: string, to: string): string {
  const a = source.indexOf(from);
  const b = source.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`marker not found: ${from} .. ${to}`);
  return codeOf(source.slice(a, b));
}

const FORBIDDEN = /fulcrumaxe|code_repo|repo_pairing|pairing|gh_owner|gh_name|allowlist|plan_id|account_plan|isPaired|planePush/i;

describe("D#598 P3b: no repo, pairing, plan or account gate on the stacked paths (static scan)", () => {
  it.each([["../src/advance/stackBase.ts"], ["../../core/src/work-items/stackParentPull.ts"]])("%s", (rel) => {
    expect(codeOf(read(rel))).not.toMatch(FORBIDDEN);
  });

  it("build.ts: the stacked-start function and the prompt branch", () => {
    const build = read("../src/advance/build.ts");
    // `resolveStackBase` reads the repository's coordinates only to pass them to the reader; it tests none of them against a name.
    const fn = between(build, "async function resolveStackBase(", "export type BuildStartResult");
    expect(fn.replace(/facts\.gh_owner|facts\.gh_name/g, "")).not.toMatch(FORBIDDEN);
    expect(between(build, "if (facts.stack_parent_id !== null && !prior) {", "const { prompt, sections }")).not.toMatch(FORBIDDEN);
  });

  it("mergeGate.ts: the stacked stop", () => {
    const gate = read("../src/build/mergeGate.ts");
    expect(between(gate, "if (typeof pr.baseRef", "if (typeof headSha")).not.toMatch(FORBIDDEN);
  });
});
