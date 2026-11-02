import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_CONFLICT_FACT_PATHS, PlaneMergeConflictFacts } from "@fulcrumaxe/runner-protocol";
import { planePushGit } from "@fulcrumaxe/runner-protocol/planePush";
import { computeConflictFacts, type FactsGit } from "../../src/daemon/conflictFacts.js";
import { createPushLog, type PushLog, type PushRecord } from "../../src/daemon/pushLog.js";
import { ledgerOptions } from "../helpers/ledgerOptions.js";

/**
 * D#519 MQ4-e2-a, C15-13 and C15-14: the conflict facts on real git. The fact pair is the private pull request: a reviewed head against the mirror's HEAD.
 * Rule (a) reads the runner's push log ("pushed by the runner"), through the one shared walk. Nothing here fakes git; the log is the real file-backed one.
 */
const T = 60_000;
const env = (): NodeJS.ProcessEnv => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
const sh = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, "-c", "user.name=Someone", "-c", "user.email=someone@example.test", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: env() }).trim();

let root: string;
let work: string;
let mirror: string;
let scratch: string;
let log: PushLog;
const ZERO = "0".repeat(40);

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-facts-"));
  work = path.join(root, "work");
  mirror = path.join(root, "mirror.git");
  scratch = path.join(root, "scratch");
  mkdirSync(work);
  mkdirSync(scratch);
  sh(work, "init", "-q", "-b", "main");
  log = createPushLog(path.join(root, "state", "push-log", "pushes.json"), ledgerOptions());
});
afterEach(() => {
  log.close();
  rmSync(root, { recursive: true, force: true });
});

const put = (files: Record<string, string>): void => {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(work, p)), { recursive: true });
    writeFileSync(path.join(work, p), c);
  }
};
const commit = (files: Record<string, string>, msg: string): string => {
  put(files);
  sh(work, "add", "-A");
  sh(work, "commit", "-q", "-m", msg);
  return sh(work, "rev-parse", "HEAD");
};
/** The mirror is a bare clone of the private repository whose HEAD is the default branch. Call after the default branch has its commits. */
const mirrorNow = (): void => {
  rmSync(mirror, { recursive: true, force: true });
  execFileSync("git", ["clone", "--bare", "-q", work, mirror], { env: env() });
};
const record = (over: Partial<PushRecord> & Pick<PushRecord, "new_sha" | "start">): void =>
  log.append({ ref: "refs/heads/fx/run", old_sha: ZERO, started_at: new Date().toISOString(), job_id: randomUUID(), ...over });

interface Fixture {
  base: string;
  /** The default branch tip the pull request conflicts with. */
  main: string;
}
/** `f.txt` is changed on the default branch after the pull request branched; the pull request's commits are made by the caller on `fx/run`. */
function branchPoint(): { base: string; toMain: (files: Record<string, string>) => Fixture } {
  const base = commit({ "f.txt": "one\n", "g.txt": "keep\n" }, "base");
  sh(work, "switch", "-q", "-c", "fx/run");
  return {
    base,
    toMain: (files) => {
      sh(work, "switch", "-q", "main");
      const main = commit(files, "default moved");
      return { base, main };
    },
  };
}
const facts = (reviewedHead: string, over: { git?: FactsGit; pushLog?: PushLog | undefined } = {}) =>
  computeConflictFacts({ privateDir: mirror, reviewedHead, scratch, pushLog: "pushLog" in over ? over.pushLog : log, ...(over.git === undefined ? {} : { git: over.git }) });

describe("C15-13: the verdict, with the fact pair of the private pull request", () => {
  it("only commits the runner pushed touch the conflict file: conflict_platform, with the base it was computed against", async () => {
    const { base, toMain } = branchPoint();
    const first = commit({ "f.txt": "pr one\n" }, "pr 1");
    const head = commit({ "f.txt": "pr two\n", "h.txt": "x\n" }, "pr 2");
    const { main } = toMain({ "f.txt": "default\n" });
    mirrorNow();
    record({ new_sha: head, start: base });
    expect(first).not.toBe(head);
    const answer = await facts(head);
    expect(answer).toEqual({ verdict: "conflict_platform", paths: ["f.txt"], base_sha: main, base_ref: "main" });
    expect(PlaneMergeConflictFacts.safeParse(answer).success).toBe(true);
  }, T);

  it("one commit that is not in the log touches a conflict file: conflict_foreign", async () => {
    const { base, toMain } = branchPoint();
    const ours = commit({ "h.txt": "ours\n" }, "ours");
    const theirs = commit({ "f.txt": "a person edited this\n" }, "person");
    toMain({ "f.txt": "default\n" });
    mirrorNow();
    record({ new_sha: ours, start: base });
    expect(await facts(theirs)).toMatchObject({ verdict: "conflict_foreign", paths: ["f.txt"] });
  }, T);

  it("a person's commit that touches no conflict file does not change the verdict", async () => {
    const { base, toMain } = branchPoint();
    const ours = commit({ "f.txt": "pr\n" }, "ours");
    const theirs = commit({ "docs.txt": "a person added a note\n" }, "person");
    toMain({ "f.txt": "default\n" });
    mirrorNow();
    record({ new_sha: ours, start: base });
    expect(await facts(theirs)).toMatchObject({ verdict: "conflict_platform", paths: ["f.txt"] });
  }, T);

  it("a record whose new is outside the pull request's commits covers nothing", async () => {
    const { base, toMain } = branchPoint();
    const theirs = commit({ "f.txt": "a person\n" }, "person");
    toMain({ "f.txt": "default\n" });
    mirrorNow();
    // `base` is the default's ancestor, not a commit of the pull request; a record naming it, or a made-up id, covers nothing.
    record({ new_sha: base, start: base });
    record({ new_sha: "b".repeat(40), start: base });
    expect(await facts(theirs)).toMatchObject({ verdict: "conflict_foreign" });
  }, T);

  it("a record whose non-zero old is outside the pull request's commits covers nothing (history was rewritten)", async () => {
    const { base, toMain } = branchPoint();
    const head = commit({ "f.txt": "pr\n" }, "pr");
    toMain({ "f.txt": "default\n" });
    mirrorNow();
    record({ new_sha: head, old_sha: "c".repeat(40), start: base });
    expect(await facts(head)).toMatchObject({ verdict: "conflict_foreign" });
  }, T);

  it("a record that created the branch is bounded by start: commits at or below it are not covered", async () => {
    const { base, toMain } = branchPoint();
    // A person's commit the run was started on top of; the run's own commit is above it.
    const persons = commit({ "f.txt": "a person\n" }, "person");
    const ours = commit({ "h.txt": "ours\n" }, "ours");
    toMain({ "f.txt": "default\n" });
    mirrorNow();
    record({ new_sha: ours, start: persons });
    expect(base).not.toBe(persons);
    expect(await facts(ours)).toMatchObject({ verdict: "conflict_foreign" });
    // The same record with a continuation (old = the person's commit) covers only the commit above it.
    const second = createPushLog(path.join(root, "state2", "push-log", "pushes.json"), ledgerOptions());
    second.append({ ref: "refs/heads/fx/run", old_sha: persons, new_sha: ours, started_at: new Date().toISOString(), job_id: randomUUID(), start: persons });
    expect(await facts(ours, { pushLog: second })).toMatchObject({ verdict: "conflict_foreign" });
    second.close();
  }, T);

  it("a merge commit on the pull request counts: an update-branch merge of the default that touches the conflict file is not the runner's (conflict_foreign)", async () => {
    const base = commit({ "f.txt": "one\n", "g.txt": "keep\n" }, "base");
    sh(work, "switch", "-q", "-c", "fx/run");
    const ours = commit({ "f.txt": "pr\n" }, "ours");
    sh(work, "switch", "-q", "main");
    commit({ "f.txt": "default one\n" }, "default moved");
    sh(work, "switch", "-q", "fx/run");
    // The default is merged into the branch by someone else (the platform's update-branch, or a person), resolving f.txt to the branch's side.
    sh(work, "merge", "-q", "-s", "ours", "main", "-m", "update branch");
    const merge = sh(work, "rev-parse", "HEAD");
    sh(work, "switch", "-q", "main");
    commit({ "f.txt": "default two\n" }, "default moved again");
    mirrorNow();
    record({ new_sha: ours, start: base });
    expect(await facts(merge)).toMatchObject({ verdict: "conflict_foreign", paths: ["f.txt"] });
    // The same history with the merge recorded as a push of the runner's is the runner's.
    record({ new_sha: merge, old_sha: ours, start: base });
    expect(await facts(merge)).toMatchObject({ verdict: "conflict_platform", paths: ["f.txt"] });
  }, T);

  it("a clean merge sends nothing (null): the 405 had another cause", async () => {
    const { toMain } = branchPoint();
    const head = commit({ "g.txt": "pr\n" }, "pr");
    toMain({ "f.txt": "default\n" });
    mirrorNow();
    expect(await facts(head)).toBeNull();
  }, T);

  it("writes nothing into the mirror: its object store is the same before and after", async () => {
    const { base, toMain } = branchPoint();
    const head = commit({ "f.txt": "pr\n" }, "pr");
    toMain({ "f.txt": "default\n" });
    mirrorNow();
    record({ new_sha: head, start: base });
    const listing = (): string => execFileSync("find", [path.join(mirror, "objects"), "-type", "f"], { encoding: "utf8" }).split("\n").sort().join("\n");
    const before = listing();
    const refsBefore = sh(mirror, "for-each-ref");
    expect((await facts(head))?.verdict).toBe("conflict_platform");
    expect(listing()).toBe(before);
    expect(sh(mirror, "for-each-ref")).toBe(refsBefore);
    // The merge's tree object went to the throwaway store.
    expect(readdirSync(path.join(scratch, "objects")).length).toBeGreaterThan(2);
  }, T);

  it("sends only names and ids: no field holds file content", async () => {
    const { base, toMain } = branchPoint();
    const head = commit({ "f.txt": "SECRET-CONTENT-LINE\n" }, "pr");
    toMain({ "f.txt": "OTHER-SECRET-LINE\n" });
    mirrorNow();
    record({ new_sha: head, start: base });
    const text = JSON.stringify(await facts(head));
    expect(text).not.toContain("SECRET");
  }, T);
});

describe("C15-14: unknown, with no paths, for each case the runner cannot establish", () => {
  const UNKNOWN = { verdict: "unknown", paths: [] };

  it("a conflict path that is not valid UTF-8", async () => {
    const { base } = branchPoint();
    writeFileSync(Buffer.concat([Buffer.from(`${work}/`), Buffer.from([0x66, 0xff, 0x2e, 0x74])]), "one\n");
    sh(work, "add", "-A");
    sh(work, "commit", "-q", "-m", "bad name");
    const baseWithBad = sh(work, "rev-parse", "HEAD");
    const head = (() => {
      writeFileSync(Buffer.concat([Buffer.from(`${work}/`), Buffer.from([0x66, 0xff, 0x2e, 0x74])]), "two\n");
      sh(work, "add", "-A");
      sh(work, "commit", "-q", "-m", "pr edits bad name");
      return sh(work, "rev-parse", "HEAD");
    })();
    sh(work, "switch", "-q", "main");
    sh(work, "merge", "-q", "--ff-only", baseWithBad);
    writeFileSync(Buffer.concat([Buffer.from(`${work}/`), Buffer.from([0x66, 0xff, 0x2e, 0x74])]), "three\n");
    sh(work, "add", "-A");
    sh(work, "commit", "-q", "-m", "default edits bad name");
    mirrorNow();
    record({ new_sha: head, start: base });
    expect(await facts(head)).toEqual(UNKNOWN);
  }, T);

  it("a reviewed head the mirror does not hold (a tree git cannot read)", async () => {
    const { toMain } = branchPoint();
    commit({ "f.txt": "pr\n" }, "pr");
    toMain({ "f.txt": "default\n" });
    mirrorNow();
    record({ new_sha: "d".repeat(40), start: "e".repeat(40) });
    expect(await facts("d".repeat(40))).toEqual(UNKNOWN);
  }, T);

  it("no merge base: a reviewed head with unrelated history", async () => {
    commit({ "f.txt": "one\n" }, "default root");
    sh(work, "switch", "-q", "--orphan", "other");
    const orphan = commit({ "f.txt": "unrelated\n" }, "unrelated root");
    sh(work, "switch", "-q", "main");
    mirrorNow();
    record({ new_sha: orphan, start: orphan });
    expect(await facts(orphan)).toEqual(UNKNOWN);
  }, T);

  it(`more than ${MAX_CONFLICT_FACT_PATHS} conflict paths`, async () => {
    const many = (suffix: string): Record<string, string> => Object.fromEntries(Array.from({ length: MAX_CONFLICT_FACT_PATHS + 1 }, (_v, i) => [`dir/f${i}.txt`, `${suffix}\n`]));
    const base = commit(many("one"), "base");
    sh(work, "switch", "-q", "-c", "fx/run");
    const head = commit(many("pr"), "pr");
    sh(work, "switch", "-q", "main");
    commit(many("default"), "default moved");
    mirrorNow();
    record({ new_sha: head, start: base });
    expect(await facts(head)).toEqual(UNKNOWN);
  }, T);

  it("a damaged or closed push log, and no push log at all", async () => {
    const { base, toMain } = branchPoint();
    const head = commit({ "f.txt": "pr\n" }, "pr");
    toMain({ "f.txt": "default\n" });
    mirrorNow();
    record({ new_sha: head, start: base });
    expect(await facts(head, { pushLog: { records: () => null } as unknown as PushLog })).toEqual(UNKNOWN);
    expect(await facts(head, { pushLog: undefined })).toEqual(UNKNOWN);
  }, T);

  it("a git older than merge-tree --write-tree needs", async () => {
    const { base, toMain } = branchPoint();
    const head = commit({ "f.txt": "pr\n" }, "pr");
    toMain({ "f.txt": "default\n" });
    mirrorNow();
    record({ new_sha: head, start: base });
    const calls: string[][] = [];
    const old: FactsGit = async (dir, args, input, extra) => {
      calls.push(args);
      return args[0] === "--version" ? Buffer.from("git version 2.30.2\n") : planePushGit(dir, args, input, extra);
    };
    expect(await facts(head, { git: old })).toEqual(UNKNOWN);
    expect(calls.some((c) => c[0] === "merge-tree")).toBe(false);
  }, T);

  it("a pull request longer than one decision reads", async () => {
    const { base, toMain } = branchPoint();
    let head = base;
    for (let i = 0; i < 101; i++) head = commit({ [`n${i}.txt`]: "x\n" }, `c${i}`);
    toMain({ "f.txt": "default\n" });
    // Make the pull request conflict too, so the length is what stops it.
    sh(work, "switch", "-q", "fx/run");
    head = commit({ "f.txt": "pr\n" }, "conflicting");
    sh(work, "switch", "-q", "main");
    mirrorNow();
    record({ new_sha: head, start: base });
    expect(await facts(head)).toEqual(UNKNOWN);
  }, T);

  it("never throws and leaves nothing behind but the scratch directory it was given", async () => {
    commit({ "f.txt": "one\n" }, "base");
    mirrorNow();
    expect(await computeConflictFacts({ privateDir: path.join(root, "nope"), reviewedHead: "f".repeat(40), scratch, pushLog: log })).toEqual(UNKNOWN);
    expect(await computeConflictFacts({ privateDir: mirror, reviewedHead: "not-a-sha", scratch, pushLog: log })).toEqual(UNKNOWN);
    expect(statSync(scratch).isDirectory()).toBe(true);
  }, T);
});
