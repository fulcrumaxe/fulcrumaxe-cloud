/**
 * D#6 R4d-2 (correction C32 section 3): every code the daemon's git path can fail a run with has a closed detail of its own. Before, the codes
 * that were not in `RUNNER_SETUP_DETAILS` were all sent as `runner_setup` / `other`, and the first real runner build ended that way.
 */
import { RUNNER_SETUP_DETAILS } from "@fulcrumaxe/runner-protocol";
import { describe, expect, it } from "vitest";
import { LocalOnlyEvent } from "@fulcrumaxe/runner-protocol";
import { endOfFailure, runEndedEvent } from "../../src/daemon/runEnded.js";
import { srcFiles } from "../helpers/srcFiles.js";

/** Every closed code a source text throws or hands to the git runner as the code for a failure: `new GitPathError("x")` and `git.run("x", ...)`. */
export function codesIn(text: string): string[] {
  return [...text.matchAll(/GitPathError\(\s*"([a-z][a-z0-9_]*)"/g), ...text.matchAll(/\.run\(\s*"([a-z][a-z0-9_]*)"\s*,/g)].map((match) => match[1]!);
}

/** Stop codes (the run ends quietly), and the codes with a reason of their own rather than a setup detail. */
const STOP_CODES = ["git_stopped", "git_revoked"];
const OWN_REASON_CODES = ["push_rejected"];

const MAPPED: ReadonlySet<string> = new Set([...RUNNER_SETUP_DETAILS, ...STOP_CODES, ...OWN_REASON_CODES]);

/**
 * Reviewed exemptions, exact file and command pairs: `RootOps.run(file, args)` of the `vm install` root phase starts a host program by name, and the pattern above
 * reads that first argument as a failure code. These are root host commands, not codes a run can end with. Nothing else is exempt: any other `.run("x", ...)` in
 * these files, or any of these commands in another file, is still an unmapped code.
 */
export const ROOT_HOST_COMMANDS: ReadonlyArray<readonly [file: string, command: string]> = [
  ["src/vm/install.ts", "getent"],
  ["src/vm/rootApply.ts", "getent"],
  ["src/vm/rootApply.ts", "systemctl"],
];

/** The codes in one file's text that no mapping or reviewed exemption covers. */
export function unmappedIn(file: string, text: string): string[] {
  return codesIn(text).filter((code) => !MAPPED.has(code) && !ROOT_HOST_COMMANDS.some(([f, c]) => f === file && c === code));
}

describe("C1: each git-path code is reported under its own detail", () => {
  const NEW = ["push_ref_refused", "snapshot_refused", "push_failed", "mirror_failed", "mirror_dir_insecure", "git_version_unsupported", "workspace_failed", "workspace_git_refused", "head_not_from_base", "sandbox_stub_committed", "review_sha_not_in_mirror", "base_conflict"];
  for (const code of NEW) {
    it(`${code} is runner_setup / ${code}`, () => {
      expect(endOfFailure(code)).toEqual({ reason: "runner_setup", detail: code });
    });
  }

  it("a code the daemon does not know is still the last resort, runner_setup / other", () => {
    expect(endOfFailure("something_new")).toEqual({ reason: "runner_setup", detail: "other" });
  });

  it("the codes that were already mapped are unchanged (resource_limit now has its own reason)", () => {
    expect(endOfFailure("push_rejected")).toEqual({ reason: "push_rejected" });
    // A job stopped by its own memory budget (D#6 C43-5) has its own reason on the wire, never the bare agent_failed; the agent's own failures keep agent_failed.
    expect(endOfFailure("resource_limit")).toEqual({ reason: "resource_limit" });
    expect(endOfFailure("sandbox_unusable")).toEqual({ reason: "runner_setup", detail: "sandbox_unusable" });
    expect(endOfFailure("git_ticket_unavailable")).toEqual({ reason: "runner_setup", detail: "git_ticket_unavailable" });
    expect(endOfFailure("git_ticket_refused")).toEqual({ reason: "runner_setup", detail: "git_ticket_refused" });
    for (const code of ["agent_error", "no_result", "agent_exit"]) expect(endOfFailure(code), code).toEqual({ reason: "agent_failed" });
    expect(endOfFailure("push_too_large", 7)).toEqual({ reason: "runner_setup", detail: "push_too_large", sizeMb: 7 });
    expect(endOfFailure("continuation_branch_missing")).toEqual({ reason: "runner_setup", detail: "continuation_branch_missing" });
    expect(endOfFailure("credential_mismatch")).toBeNull();
  });
});

describe("C2: a new git-path code without a detail fails here", () => {
  it("every code named in fx-runner/src is a setup detail, a stop code, or already has its own reason", () => {
    const unmapped: string[] = [];
    for (const [file, text] of srcFiles()) {
      for (const code of unmappedIn(file, text)) unmapped.push(`${file}: ${code}`);
    }
    expect(unmapped).toEqual([]);
  });

  it("the root host command exemption is exact: another command in those files, or the same command in another file, still fails", () => {
    expect(unmappedIn("src/vm/rootApply.ts", 'await ops.run("systemctl", ["x"]);\nawait ops.run("getent", []);')).toEqual([]);
    expect(unmappedIn("src/vm/install.ts", 'await host.ops.run("getent", ["passwd", u]);')).toEqual([]);
    expect(unmappedIn("src/vm/rootApply.ts", 'await ops.run("useradd", []);')).toEqual(["useradd"]);
    expect(unmappedIn("src/vm/install.ts", 'await host.ops.run("systemctl", []);')).toEqual(["systemctl"]);
    expect(unmappedIn("src/vm/uninstall.ts", 'await ops.run("getent", []);')).toEqual(["getent"]);
    expect(unmappedIn("src/daemon/other.ts", 'throw new GitPathError("getent");')).toEqual(["getent"]);
  });

  it("every exempted pair is really used (a stale exemption fails here)", () => {
    const files = new Map(srcFiles());
    for (const [file, command] of ROOT_HOST_COMMANDS) expect(codesIn(files.get(file) ?? "").includes(command), `${file}: ${command}`).toBe(true);
  });

  it("the scan sees both ways a code is named, and would catch one that is not mapped", () => {
    const sample = 'throw new GitPathError("brand_new_code");\nawait git.run("another_new_one", ["status"]);\nthrow new GitPathError("push_failed", 3);';
    expect(codesIn(sample)).toEqual(["brand_new_code", "push_failed", "another_new_one"]);
    expect(codesIn(sample).filter((code) => !MAPPED.has(code))).toEqual(["brand_new_code", "another_new_one"]);
  });

  it("the scan finds the codes this path really uses (it is not scanning nothing)", () => {
    const found = new Set(srcFiles().flatMap(([, text]) => codesIn(text)));
    for (const code of ["push_ref_refused", "push_failed", "head_not_from_base", "sandbox_stub_committed", "workspace_git_refused", "mirror_failed", "workspace_failed", "review_sha_not_in_mirror", "base_conflict"]) expect(found.has(code), code).toBe(true);
  });
});

describe("D#6 CARD-OOM-CAUSE-WORDS: the memory cap on a resource_limit end", () => {
  const GIB = 1024 ** 3;
  const at = new Date("2026-10-31T12:00:00.000Z");
  it("rides on resource_limit only, and becomes memory_limit_bytes on the wire event", () => {
    expect(endOfFailure("resource_limit", undefined, 6 * GIB)).toEqual({ reason: "resource_limit", memoryLimitBytes: 6 * GIB });
    expect(endOfFailure("agent_error", undefined, 6 * GIB)).toEqual({ reason: "agent_failed" });
    expect(endOfFailure("push_too_large", 7, 6 * GIB)).toEqual({ reason: "runner_setup", detail: "push_too_large", sizeMb: 7 });
    expect(runEndedEvent(3, at, { reason: "resource_limit", memoryLimitBytes: 6 * GIB })).toMatchObject({ type: "run_ended", reason: "resource_limit", memory_limit_bytes: 6 * GIB });
    expect(runEndedEvent(3, at, { reason: "resource_limit" })).not.toHaveProperty("memory_limit_bytes");
  });

  it("an event the protocol would refuse is a bug here, not a send", () => {
    expect(() => runEndedEvent(3, at, { reason: "resource_limit", memoryLimitBytes: 0 })).toThrow();
    expect(() => runEndedEvent(3, at, { reason: "agent_failed", memoryLimitBytes: 6 * GIB })).toThrow();
    expect(LocalOnlyEvent.safeParse(runEndedEvent(3, at, { reason: "resource_limit", memoryLimitBytes: 2 ** 40 })).success).toBe(true);
  });
});
