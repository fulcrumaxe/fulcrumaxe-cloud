import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConflictAttestation, MAX_CONFLICT_ATTEST_PATHS } from "@fulcrumaxe/runner-protocol";
import { computeConflictAttestation } from "../../src/daemon/conflictAttest.js";
import { createPushLog, type PushLog } from "../../src/daemon/pushLog.js";
import { RUNNER_BUILD_CAPABILITIES } from "../../src/version.js";
import { ledgerOptions } from "../helpers/ledgerOptions.js";

/**
 * D#519 MQ4-e2-c1 (C18-2): the runner's attestation at the end of a conflict round, on real git and the real push log. The anchors are the cloud's signed values; every damaged input gives
 * a closed negative, never a pass. The job here has `from_sha` = the branch tip before the round and `base_sha` = the default tip the round was asked to merge.
 */
const T = 60_000;
const env = (): NodeJS.ProcessEnv => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
const sh = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, "-c", "user.name=Someone", "-c", "user.email=someone@example.test", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: env() }).trim();

let root: string;
let work: string;
let mirror: string;
let log: PushLog;
const JOB = randomUUID();
const ZERO = "0".repeat(40);

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-attest-"));
  work = path.join(root, "work");
  mirror = path.join(root, "mirror.git");
  mkdirSync(work);
  sh(work, "init", "-q", "-b", "main");
  log = createPushLog(path.join(root, "state", "push-log", "pushes.json"), ledgerOptions());
});
afterEach(() => {
  log.close();
  rmSync(root, { recursive: true, force: true });
});

const commit = (files: Record<string, string>, msg: string): string => {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(work, p)), { recursive: true });
    writeFileSync(path.join(work, p), c);
  }
  sh(work, "add", "-A");
  sh(work, "commit", "-q", "-m", msg);
  return sh(work, "rev-parse", "HEAD");
};
const mirrorNow = (): void => {
  rmSync(mirror, { recursive: true, force: true });
  execFileSync("git", ["clone", "--bare", "-q", work, mirror], { env: env() });
};
const pushed = (head: string, from: string, jobId = JOB): void => log.append({ ref: "refs/heads/fx/run", old_sha: from, new_sha: head, started_at: new Date().toISOString(), job_id: jobId, start: from });

/** A branch point, a pull request commit on `fx/run`, and a default-branch commit that touches the same line (the conflict the round was asked to resolve). */
function conflict(): { from: string; base: string } {
  commit({ "f.txt": "one\n", "g.txt": "keep\n" }, "base");
  sh(work, "checkout", "-q", "-b", "fx/run");
  const from = commit({ "f.txt": "branch\n" }, "pull request change");
  sh(work, "checkout", "-q", "main");
  const base = commit({ "f.txt": "main\n", "h.txt": "new on main\n" }, "main moved");
  return { from, base };
}
/** The round's merge, resolved: parents [from, base] in that order. */
function mergeRound(): string {
  sh(work, "checkout", "-q", "fx/run");
  try {
    sh(work, "merge", "--no-ff", "-q", "-m", "merge main", "main");
  } catch {
    // fx-swallow-ok: the fixture's merge is meant to conflict; the resolution below is the round's work
  }
  writeFileSync(path.join(work, "f.txt"), "resolved\n");
  sh(work, "add", "-A");
  sh(work, "commit", "-q", "-m", "merge main");
  return sh(work, "rev-parse", "HEAD");
}
const attest = (head: string, from: string, base: string, over: { pushLog?: Pick<PushLog, "records"> } = {}) =>
  computeConflictAttestation({ mirrorDir: mirror, scratchRoot: path.join(root, "attest-scratch"), head, jobId: JOB, round: { from_sha: from, base_sha: base, base_ref: "main" }, pushLog: "pushLog" in over ? over.pushLog : log });

describe("the conflict attestation, on real git", () => {
  it("a clean merge of the signed base into the signed start, recorded in the push log, reads descendant and pushed by the round", async () => {
    const { from, base } = conflict();
    const head = mergeRound();
    sh(work, "checkout", "-q", "main");
    mirrorNow();
    pushed(head, from);
    const got = await attest(head, from, base);
    expect(ConflictAttestation.safeParse(got).success).toBe(true);
    expect(got).toEqual({
      head,
      parents: [from, base],
      from_sha: from,
      base_sha: base,
      history: "descendant",
      pushed_by_round: true,
      second_parent_on_default: true,
      still_conflicting: "no",
      touched_paths: expect.arrayContaining(["f.txt"]),
      truncated: false,
    });
  }, T);

  it("a person's extra commit on top of the merge is a non-merge head the push log does not hold", async () => {
    const { from, base } = conflict();
    const merged = mergeRound();
    pushed(merged, from);
    const head = commit({ "extra.txt": "a person wrote this\n" }, "person");
    sh(work, "checkout", "-q", "main");
    mirrorNow();
    const got = await attest(head, from, base);
    expect(got).toMatchObject({ head, parents: [merged], pushed_by_round: false, second_parent_on_default: false });
  }, T);

  it("a rebase of the branch onto the new tip is not a descendant of the signed start", async () => {
    const { from, base } = conflict();
    sh(work, "checkout", "-q", "fx/run");
    try {
      sh(work, "rebase", "main");
    } catch {
      // fx-swallow-ok: the fixture's rebase conflicts on purpose
    }
    writeFileSync(path.join(work, "f.txt"), "rebased\n");
    sh(work, "add", "-A");
    sh(work, "-c", "core.editor=true", "rebase", "--continue");
    const head = sh(work, "rev-parse", "HEAD");
    sh(work, "checkout", "-q", "main");
    mirrorNow();
    pushed(head, from);
    const got = await attest(head, from, base);
    expect(got).toMatchObject({ history: "not", parents: [base] });
  }, T);

  it("a damaged or missing push log reads as not pushed by the round, never as pushed", async () => {
    const { from, base } = conflict();
    const head = mergeRound();
    sh(work, "checkout", "-q", "main");
    mirrorNow();
    pushed(head, from);
    expect((await attest(head, from, base, { pushLog: { records: () => null } }))?.pushed_by_round).toBe(false);
    expect((await attest(head, from, base, { pushLog: undefined }))?.pushed_by_round).toBe(false);
    // A record of another job, of another head, or from another start does not count either.
    const other = createPushLog(path.join(root, "state", "other", "pushes.json"), ledgerOptions());
    other.append({ ref: "refs/heads/fx/run", old_sha: from, new_sha: head, started_at: new Date().toISOString(), job_id: randomUUID(), start: from });
    other.append({ ref: "refs/heads/fx/run", old_sha: from, new_sha: from, started_at: new Date().toISOString(), job_id: JOB, start: from });
    other.append({ ref: "refs/heads/fx/run", old_sha: ZERO, new_sha: head, started_at: new Date().toISOString(), job_id: JOB, start: from });
    expect((await attest(head, from, base, { pushLog: other }))?.pushed_by_round).toBe(false);
    other.close();
  }, T);

  it("more than the path cap is truncated to the cap, and the flag says so", async () => {
    const { from, base } = conflict();
    sh(work, "checkout", "-q", "fx/run");
    try {
      sh(work, "merge", "--no-ff", "-q", "-m", "merge main", "main");
    } catch {
      // fx-swallow-ok: the fixture's merge conflicts on purpose
    }
    const many: Record<string, string> = { "f.txt": "resolved\n" };
    for (let i = 0; i <= MAX_CONFLICT_ATTEST_PATHS; i++) many[`bulk/f${i}.txt`] = `${i}\n`;
    for (const [p, c] of Object.entries(many)) {
      mkdirSync(path.dirname(path.join(work, p)), { recursive: true });
      writeFileSync(path.join(work, p), c);
    }
    sh(work, "add", "-A");
    sh(work, "commit", "-q", "-m", "merge main");
    const head = sh(work, "rev-parse", "HEAD");
    sh(work, "checkout", "-q", "main");
    mirrorNow();
    pushed(head, from);
    const got = await attest(head, from, base);
    expect(got?.truncated).toBe(true);
    expect(got?.touched_paths).toHaveLength(MAX_CONFLICT_ATTEST_PATHS);
  }, T);

  it("a head the mirror does not hold, or a malformed one, attests nothing", async () => {
    const { from, base } = conflict();
    sh(work, "checkout", "-q", "main");
    mirrorNow();
    expect(await attest("e".repeat(40), from, base)).toBeUndefined();
    expect(await attest("not-a-sha", from, base)).toBeUndefined();
  }, T);

  it("the runner build always lists conflict_facts_v1, which the cloud requires of a conflict attestation", () => {
    expect(RUNNER_BUILD_CAPABILITIES).toContain("conflict_facts_v1");
  });
});
