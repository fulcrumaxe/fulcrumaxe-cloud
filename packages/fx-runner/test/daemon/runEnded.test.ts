/**
 * D#6 R4d-2 (correction C32 section 3): every code the daemon's git path can fail a run with has a closed detail of its own. Before, the codes
 * that were not in `RUNNER_SETUP_DETAILS` were all sent as `runner_setup` / `other`, and the first real runner build ended that way.
 */
import { RUNNER_SETUP_DETAILS } from "@fulcrumaxe/runner-protocol";
import { describe, expect, it } from "vitest";
import { endOfFailure } from "../../src/daemon/runEnded.js";
import { srcFiles } from "../helpers/srcFiles.js";

/** Every closed code a source text throws or hands to the git runner as the code for a failure: `new GitPathError("x")` and `git.run("x", ...)`. */
export function codesIn(text: string): string[] {
  return [...text.matchAll(/GitPathError\(\s*"([a-z][a-z0-9_]*)"/g), ...text.matchAll(/\.run\(\s*"([a-z][a-z0-9_]*)"\s*,/g)].map((match) => match[1]!);
}

/** Stop codes (the run ends quietly), and the codes with a reason of their own rather than a setup detail. */
const STOP_CODES = ["git_stopped", "git_revoked"];
const OWN_REASON_CODES = ["push_rejected"];

const MAPPED: ReadonlySet<string> = new Set([...RUNNER_SETUP_DETAILS, ...STOP_CODES, ...OWN_REASON_CODES]);

describe("C1: each git-path code is reported under its own detail", () => {
  const NEW = ["push_ref_refused", "snapshot_refused", "push_failed", "mirror_failed", "mirror_dir_insecure", "git_version_unsupported", "workspace_failed", "workspace_git_refused", "head_not_from_base", "sandbox_stub_committed", "review_sha_not_in_mirror"];
  for (const code of NEW) {
    it(`${code} is runner_setup / ${code}`, () => {
      expect(endOfFailure(code)).toEqual({ reason: "runner_setup", detail: code });
    });
  }

  it("a code the daemon does not know is still the last resort, runner_setup / other", () => {
    expect(endOfFailure("something_new")).toEqual({ reason: "runner_setup", detail: "other" });
  });

  it("the codes that were already mapped are unchanged", () => {
    expect(endOfFailure("push_rejected")).toEqual({ reason: "push_rejected" });
    expect(endOfFailure("push_too_large", 7)).toEqual({ reason: "runner_setup", detail: "push_too_large", sizeMb: 7 });
    expect(endOfFailure("continuation_branch_missing")).toEqual({ reason: "runner_setup", detail: "continuation_branch_missing" });
    expect(endOfFailure("credential_mismatch")).toBeNull();
  });
});

describe("C2: a new git-path code without a detail fails here", () => {
  it("every code named in fx-runner/src is a setup detail, a stop code, or already has its own reason", () => {
    const unmapped: string[] = [];
    for (const [file, text] of srcFiles()) {
      for (const code of codesIn(text)) if (!MAPPED.has(code)) unmapped.push(`${file}: ${code}`);
    }
    expect(unmapped).toEqual([]);
  });

  it("the scan sees both ways a code is named, and would catch one that is not mapped", () => {
    const sample = 'throw new GitPathError("brand_new_code");\nawait git.run("another_new_one", ["status"]);\nthrow new GitPathError("push_failed", 3);';
    expect(codesIn(sample)).toEqual(["brand_new_code", "push_failed", "another_new_one"]);
    expect(codesIn(sample).filter((code) => !MAPPED.has(code))).toEqual(["brand_new_code", "another_new_one"]);
  });

  it("the scan finds the codes this path really uses (it is not scanning nothing)", () => {
    const found = new Set(srcFiles().flatMap(([, text]) => codesIn(text)));
    for (const code of ["push_ref_refused", "push_failed", "head_not_from_base", "sandbox_stub_committed", "workspace_git_refused", "mirror_failed", "workspace_failed", "review_sha_not_in_mirror"]) expect(found.has(code), code).toBe(true);
  });
});
