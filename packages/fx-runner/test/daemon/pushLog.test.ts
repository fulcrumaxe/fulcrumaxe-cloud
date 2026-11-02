import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { openPushLog } from "../../src/commands/run.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGit, GitPathError, type GitCapture } from "../../src/daemon/git.js";
import { createGitPath, type GitJob } from "../../src/daemon/gitPath.js";
import { LedgerLockedError } from "../../src/daemon/ledger.js";
import { publishBranch, pushPlan, runPush } from "../../src/daemon/push.js";
import { createPushLog, PUSH_LOG_KEEP_MS, PUSH_LOG_MAX, sinkFor, type PushRecord } from "../../src/daemon/pushLog.js";
import { runCapture } from "../../src/engines/claude/capture.js";
import { ledgerOptions } from "../helpers/ledgerOptions.js";
import { testLaunch } from "../helpers/launch.js";

let root: string;
let file: string;
const OID = (n: number): string => n.toString(16).padStart(40, "a");
const rec = (n: number, over: Partial<PushRecord> = {}): PushRecord => ({ ref: "refs/heads/fx/x", old_sha: OID(n), new_sha: OID(n + 1), started_at: new Date(1_000_000).toISOString(), job_id: randomUUID(), start: OID(1), ...over });

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-pushlog-"));
  file = path.join(root, "state", "push-log", "pushes.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the push log file (C15-9)", () => {
  it("is a 0600 file in a 0700 directory, replaced atomically, and survives a reopen", () => {
    const log = createPushLog(file, ledgerOptions(() => new Date(1_000_000)));
    log.append(rec(1));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(readdirSync(path.dirname(file)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    log.close();
    const again = createPushLog(file, ledgerOptions(() => new Date(1_000_000)));
    expect(again.records()).toHaveLength(1);
    again.close();
  });

  it("is held by one process at a time", () => {
    const log = createPushLog(file, ledgerOptions());
    expect(() => createPushLog(file, ledgerOptions())).toThrow(LedgerLockedError);
    log.close();
    createPushLog(file, ledgerOptions()).close();
  });

  it("a damaged file is moved aside and the log fails closed: unknown, and no append", () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '[{"ref":"nope"}]');
    const log = createPushLog(file, ledgerOptions());
    expect(log.closed).toBe(true);
    expect(log.records()).toBeNull();
    expect(() => log.append(rec(1))).toThrow();
    expect(readdirSync(path.dirname(file)).some((n) => n.startsWith("pushes.json.damaged-"))).toBe(true);
    expect(existsSync(file)).toBe(false);
    log.close();
    // a missing file next to a moved-aside one is still closed, a restart does not reopen it
    const restarted = createPushLog(file, ledgerOptions());
    expect(restarted.closed).toBe(true);
    restarted.close();
  });

  it("drops entries past 96 hours and keeps at most 5,000, oldest first", () => {
    let now = 1_000_000;
    const log = createPushLog(file, ledgerOptions(() => new Date(now)));
    log.append(rec(1));
    now += PUSH_LOG_KEEP_MS + 1;
    expect(log.records()).toEqual([]);
    log.append(rec(2, { started_at: new Date(now).toISOString() }));
    expect(log.records()!.map((r) => r.old_sha)).toEqual([OID(2)]);
    log.close();
    // a full file (written by hand, one write instead of 5,000): the next appends push the oldest out
    const stamp = new Date(now).toISOString();
    writeFileSync(file, JSON.stringify(Array.from({ length: PUSH_LOG_MAX }, (_, i) => rec(10 + i, { started_at: stamp }))));
    const full = createPushLog(file, ledgerOptions(() => new Date(now)));
    expect(full.records()).toHaveLength(PUSH_LOG_MAX);
    for (let i = 0; i < 3; i++) full.append(rec(100_000 + i, { started_at: stamp }));
    const kept = full.records()!;
    expect(kept).toHaveLength(PUSH_LOG_MAX);
    expect(kept.at(-1)!.old_sha).toBe(OID(100_002));
    expect(kept[0]!.old_sha).toBe(OID(13));
    full.close();
  });

  it("a write that fails keeps nothing", () => {
    const log = createPushLog(file, ledgerOptions(() => new Date(1_000_000)));
    log.append(rec(1));
    rmSync(path.dirname(file), { recursive: true, force: true });
    expect(() => log.append(rec(2))).toThrow();
    expect(log.records()).toHaveLength(1);
  });
});

describe("what publishBranch records, with real git (C15-7, C15-8, C15-11)", () => {
  let remote: string;
  let home: string;
  const env = (): Record<string, string> => ({ PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" });
  const sh = (...args: string[]): string => execFileSync("git", args, { env: env(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const commit = (dir: string, name: string): string => {
    writeFileSync(path.join(dir, name), "x\n");
    sh("-C", dir, "add", name);
    sh("-C", dir, "commit", "-m", name);
    return sh("-C", dir, "rev-parse", "HEAD").trim();
  };
  const lease = { runId: "0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f", leaseGeneration: 1 };
  const FIX = { runId: "7c7c7c7c-7d7d-4e7e-8f7f-707070707070", leaseGeneration: 2 };
  const jobId = "11111111-2222-4333-8444-555555555555";

  function rig() {
    const log = createPushLog(file, ledgerOptions());
    const capture: GitCapture = (command, args, e, timeoutMs) => runCapture(spawn, testLaunch(), command, args, e, timeoutMs);
    const gitPath = createGitPath({ platform: "linux", capture, mirrorsRoot: path.join(root, "cache", "mirrors"), stateDir: path.join(root, "state"), remoteUrl: () => pathToFileURL(remote).href, pushLog: log });
    const job = (over: Partial<GitJob> = {}): GitJob => ({ job_id: jobId, repo: { id: randomUUID(), owner: "acme", name: "widgets", private: true }, continues: null, branch_prefix: "fx/", role: "executor", ...over });
    return { log, gitPath, job };
  }
  function workspace(name: string): string {
    const dir = path.join(root, "work", name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  beforeEach(() => {
    home = path.join(root, "home");
    mkdirSync(home);
    remote = path.join(root, "remote.git");
    sh("init", "--bare", "-b", "main", remote);
    const seed = path.join(root, "seed");
    sh("init", "-b", "main", seed);
    commit(seed, "README.md");
    sh("-C", seed, "push", remote, "main");
  });

  it("a fresh branch records the zero old oid; a continuation records the base; a person's plain push between runs records nothing", async () => {
    const { log, gitPath, job } = rig();
    const j = job();
    const w1 = workspace("one");
    const first = await gitPath.prepare(j, lease, w1);
    const c1 = commit(w1, "a.txt");
    await gitPath.publish(j, lease, w1, first.base);
    const branch = pushPlan(lease).branch;
    expect(log.records()).toEqual([{ ref: `refs/heads/${branch}`, old_sha: "0".repeat(40), new_sha: c1, started_at: expect.any(String), job_id: jobId, start: first.base }]);

    // a person pushes to the same branch with plain git: nothing the daemon wrote, so no record
    const person = path.join(root, "person");
    sh("clone", "--branch", branch, remote, person);
    const byHand = commit(person, "hand.txt");
    sh("-C", person, "push", "origin", branch);
    expect(log.records()).toHaveLength(1);

    const fix = job({ continues: { parent_run_id: randomUUID(), session_id: "s", branch } });
    const w2 = workspace("two");
    const second = await gitPath.prepare(fix, FIX, w2);
    expect(second.base).toBe(byHand);
    const c2 = commit(w2, "b.txt");
    await gitPath.publish(fix, FIX, w2, second.base);
    const all = log.records()!;
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ ref: `refs/heads/${branch}`, old_sha: byHand, new_sha: c2, start: byHand });
    // the person's commit is in nobody's `new_sha`: it reads foreign
    expect(all.map((r) => r.new_sha)).not.toContain(byHand);
    log.close();
  });

  it("a chunked push (path A) records one entry per chunk, in order, each following the one before", async () => {
    const { log, gitPath, job } = rig();
    const j = job();
    const w = workspace("big");
    const { base } = await gitPath.prepare(j, lease, w);
    writeFileSync(path.join(w, "one.bin"), randomBytes(2_600_000));
    sh("-C", w, "add", "one.bin");
    sh("-C", w, "commit", "-m", "one");
    const c1 = sh("-C", w, "rev-parse", "HEAD").trim();
    writeFileSync(path.join(w, "two.bin"), randomBytes(2_600_000));
    sh("-C", w, "add", "two.bin");
    sh("-C", w, "commit", "-m", "two");
    const c2 = sh("-C", w, "rev-parse", "HEAD").trim();
    const git = createGit({ capture: (c, a, e, t) => runCapture(spawn, testLaunch(), c, a, e, t) });
    const mirror = path.join(root, "cache", "mirrors", `${j.repo.id}.git`);
    const transport = { open: async () => ({ git, url: pathToFileURL(remote).href }) };
    await publishBranch(git, mirror, "", w, base, lease, path.join(root, "state", "git-snapshots"), { transport, pushLog: sinkFor(log, jobId) });
    const branch = pushPlan(lease).branch;
    expect(log.records()!.map((r) => [r.ref, r.old_sha, r.new_sha])).toEqual([
      [`refs/heads/${branch}`, "0".repeat(40), c1],
      [`refs/heads/${branch}`, c1, c2],
    ]);
    log.close();
  });

  it("a push that fails, is refused or is stopped records nothing, and no record has a force field", async () => {
    const { log, gitPath, job } = rig();
    const j = job();
    const w = workspace("one");
    const { base } = await gitPath.prepare(j, lease, w);
    commit(w, "a.txt");
    await gitPath.publish(j, lease, w, base, () => true);
    expect(log.records()).toEqual([]);
    const git = createGit({ capture: (c, a, e, t) => runCapture(spawn, testLaunch(), c, a, e, t) });
    const mirror = path.join(root, "cache", "mirrors", `${j.repo.id}.git`);
    await expect(runPush(git, mirror, pathToFileURL(remote).href, `+refs/fx-push/x:refs/heads/main`, lease)).rejects.toBeInstanceOf(GitPathError);
    // a remote that refuses the push (unreachable address) leaves nothing
    const sink = sinkFor(log, jobId);
    await expect(publishBranch(git, mirror, pathToFileURL(path.join(root, "missing.git")).href, w, base, lease, path.join(root, "state", "git-snapshots"), { pushLog: sink })).rejects.toMatchObject({ code: "push_failed" });
    expect(log.records()).toEqual([]);
    sink.record({ ref: "refs/heads/fx/x", old: OID(1), new: OID(2), start: OID(1), startedAt: new Date() });
    expect(Object.keys(log.records()![0]!).sort()).toEqual(["job_id", "new_sha", "old_sha", "ref", "start", "started_at"]);
    log.close();
  });

  it("a log that cannot take the entry never fails a push that landed", async () => {
    const { log, gitPath, job } = rig();
    const j = job();
    const w = workspace("one");
    const { base } = await gitPath.prepare(j, lease, w);
    const c = commit(w, "a.txt");
    rmSync(path.dirname(file), { recursive: true, force: true });
    await expect(gitPath.publish(j, lease, w, base)).resolves.toMatchObject({ pushed: true, sha: c });
    expect(log.records()).toEqual([]);
  });

  it("the source never reads the log back from a job or names a way to send it", () => {
    const text = readFileSync(path.join(__dirname, "..", "..", "src", "daemon", "pushLog.ts"), "utf8");
    expect(text).not.toMatch(/fetch\(|http|client\./);
  });
});

describe("the bounds, damage, links and wiring are pinned by value", () => {
  const clock = (ms: number) => ledgerOptions(() => new Date(ms));
  const HOUR = 3_600_000;

  it("the literal bounds: 96 hours and 5,000 entries", () => {
    expect(PUSH_LOG_KEEP_MS).toBe(96 * HOUR);
    expect(PUSH_LOG_MAX).toBe(5000);
    const t0 = 10_000 * HOUR;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify([rec(1, { started_at: new Date(t0 - 97 * HOUR).toISOString() }), rec(2, { started_at: new Date(t0 - 95 * HOUR).toISOString() })]));
    const log = createPushLog(file, clock(t0));
    expect(log.records()!.map((r) => r.old_sha)).toEqual([OID(2)]);
    log.close();
    const stamp = new Date(t0).toISOString();
    writeFileSync(file, JSON.stringify(Array.from({ length: 5001 }, (_, i) => rec(i + 1, { started_at: stamp }))));
    const big = createPushLog(file, clock(t0));
    expect(big.records()).toHaveLength(5000);
    big.close();
  });

  it.each([["not JSON", "this is not json"], ["truncated", '[{"ref":"refs/heads/fx/x","old_sha":"'], ["not an array", "{}"]])("a %s file is moved aside and the log closes: unknown, no append", (_name, text) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    const log = createPushLog(file, clock(1_000_000));
    expect(log.closed).toBe(true);
    expect(log.records()).toBeNull();
    expect(() => log.append(rec(1))).toThrow("push_log_closed");
    expect(readdirSync(path.dirname(file)).filter((n) => n.startsWith("pushes.json.damaged-"))).toHaveLength(1);
    expect(existsSync(file)).toBe(false);
    log.close();
  });

  it("a record that would not read back is refused before it is written", () => {
    const log = createPushLog(file, clock(1_000_000));
    expect(() => log.append(rec(1, { ref: "main" }))).toThrow("push_log_record_invalid");
    expect(existsSync(file)).toBe(false);
    log.close();
  });

  it("a link planted at the log path is replaced by the append, never written through; the temp file is opened exclusively", () => {
    const log = createPushLog(file, clock(1_000_000));
    log.append(rec(1));
    const target = path.join(root, "target.json");
    writeFileSync(target, "[]");
    rmSync(file);
    symlinkSync(target, file);
    log.append(rec(2));
    expect(readFileSync(target, "utf8")).toBe("[]");
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(__dirname, "..", "..", "src", "daemon", "pushLog.ts"), "utf8")).toContain('openSync(temp, "wx", 0o600)');
    log.close();
  });

  it("openPushLog puts the log under the state directory, and says so once when it starts closed", () => {
    const lines: string[] = [];
    const state = path.join(root, "state");
    const ok = openPushLog(state, clock(1_000_000), (l) => lines.push(l));
    ok.append(rec(1));
    expect(existsSync(path.join(state, "push-log", "pushes.json"))).toBe(true);
    expect(lines).toEqual([]);
    ok.close();
    writeFileSync(path.join(state, "push-log", "pushes.json"), "garbage");
    const closed = openPushLog(state, clock(1_000_000), (l) => lines.push(l));
    expect(closed.closed).toBe(true);
    expect(lines).toEqual(["fx-runner: the push log is damaged and closed (see push-log/pushes.json.damaged-* in the state directory); it reopens empty once that file is removed"]);
    // the way back: remove the moved-aside file and the log reopens empty
    for (const name of readdirSync(path.join(state, "push-log"))) if (name.includes(".damaged-")) rmSync(path.join(state, "push-log", name));
    expect(closed.records()).toEqual([]);
    closed.close();
  });

  it("the daemon start hands the log to both git paths (createGitPath and createGitPathA) and builds it with openPushLog", () => {
    const run = readFileSync(path.join(__dirname, "..", "..", "src", "commands", "run.ts"), "utf8");
    const lineWith = (needle: string): string => run.split("\n").find((l) => l.includes(needle)) ?? "";
    expect(lineWith("const git = createGitPath({")).toMatch(/\bpushLog\b/);
    expect(lineWith("createGitPathA({")).toMatch(/\bpushLog\b/);
    expect(lineWith("pushLog = openPushLog(")).toContain("stateDir");
    expect(readFileSync(path.join(__dirname, "..", "..", "src", "daemon", "gitPathA.ts"), "utf8")).toContain("...pushSinkOf(deps.pushLog, job)");
  });
});
