import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBaseFile, createChangedFiles, createHeadBlob, createIndexHidesChanges } from "../../src/daemon/checkStep.js";
import { DERIVED_FILES_TABLE_PATH, readDerivedRules, verifyDerivedOutputs } from "../../src/daemon/derivedStep.js";
import { type GitCapture } from "../../src/daemon/git.js";
import { createGitPath, type GitJob } from "../../src/daemon/gitPath.js";
import { scopeVerdict } from "../../src/daemon/scopeStep.js";
import { pushPlan } from "../../src/daemon/push.js";
import { runCapture } from "../../src/engines/claude/capture.js";
import { testLaunch } from "../helpers/launch.js";

/**
 * A fix round continues a branch cut earlier; the repository's default branch has moved on (a repaired test, say). The runner brings the branch up to date before the agent
 * starts (`updateWorkspaceBranch`). Real git over a local bare remote, no network.
 */
const T = 60_000;
let root: string;
let home: string;
let remote: string;
let remoteUrl: string;

const SETUP_ENV = (): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: home,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
});
const sh = (...args: string[]): string => execFileSync("git", args, { env: SETUP_ENV(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const tip = (repo: string, ref: string): string => sh("-C", repo, "rev-parse", ref).trim();

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-baseupdate-"));
  home = path.join(root, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  remote = path.join(root, "remote.git");
  sh("init", "--bare", "-b", "main", remote);
  const seed = path.join(root, "seed");
  sh("init", "-b", "main", seed);
  writeFileSync(path.join(seed, "README.md"), "hello\n");
  writeFileSync(path.join(seed, "flaky.test.txt"), "broken\n");
  sh("-C", seed, "add", "README.md", "flaky.test.txt");
  sh("-C", seed, "commit", "-m", "first");
  sh("-C", seed, "push", remote, "main");
  remoteUrl = pathToFileURL(remote).href;
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const capture: GitCapture = (command, args, env, timeoutMs) => runCapture(spawn, testLaunch(), command, args, env, timeoutMs);
function makeGitPath() {
  return createGitPath({ platform: "linux", capture, mirrorsRoot: path.join(root, "cache", "mirrors"), stateDir: path.join(root, "state"), remoteUrl: () => remoteUrl });
}

const lease = { runId: "0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f", leaseGeneration: 1 };
const FIX_LEASE = { runId: "7c7c7c7c-7d7d-4e7e-8f7f-707070707070", leaseGeneration: 2 };
const CHECK = { argv: ["bash", "scripts/check.sh"], dev_shell: false, timeout_s: 60 };
const repo = { id: randomUUID(), owner: "acme", name: "widgets", private: true as const };
const jobFor = (over: Partial<GitJob> = {}): GitJob => ({ repo, continues: null, branch_prefix: "fx/", role: "executor", ...over });
const continuesOn = (branch: string) => ({ parent_run_id: randomUUID(), session_id: "s1", branch });
const fixJobOn = (branch: string, over: Partial<GitJob> = {}): GitJob => jobFor({ continues: continuesOn(branch), check: CHECK, ...over });

function newWorkspace(name: string): string {
  const dir = path.join(root, "work", name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** The first run, whose check failed: its commit is pushed to the run branch and no pull request is opened for it. */
async function firstRun(gitPath: ReturnType<typeof makeGitPath>) {
  const job = jobFor();
  const workspace = newWorkspace("first");
  const { base } = await gitPath.prepare(job, lease, workspace);
  writeFileSync(path.join(workspace, "agent.txt"), "work\n");
  sh("-C", workspace, "add", "agent.txt");
  sh("-C", workspace, "commit", "-m", "agent change");
  const commit = tip(workspace, "HEAD");
  await gitPath.publish(job, lease, workspace, base);
  return { branch: pushPlan(lease).branch, commit, workspace };
}

/** The default branch moves: a commit that repairs the test, and optionally another file. */
function mainMoves(files: Record<string, string> = { "flaky.test.txt": "fixed\n" }): string {
  const other = path.join(root, `main-${randomUUID()}`);
  sh("clone", "--branch", "main", remote, other);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(other, name)), { recursive: true });
    writeFileSync(path.join(other, name), text);
    sh("-C", other, "add", name);
  }
  sh("-C", other, "commit", "-m", "repair the test");
  sh("-C", other, "push", "origin", "main");
  return tip(other, "HEAD");
}



const TABLE = JSON.stringify({ version: 1, rules: [{ id: "api-routes", kind: "generated", inputs: ["packages/api/src/routes/**"], outputs: ["packages/api/openapi.json", "packages/api-client/src/generated.ts"], generators: [["gen-openapi"], ["gen-client"]] }] });
const ROUTE = "packages/api/src/routes/runs.ts";
const OPENAPI = "packages/api/openapi.json";

const put = (dir: string, rel: string, text: string): void => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
};

describe("the pin the derived-files table is read at (jobHandler: updatedTo ?? checkBase)", () => {
  it("a continued branch cut before the table: the merged-in default tip is in the mirror and holds the table", { timeout: T }, async () => {
    const gitPath = makeGitPath();
    const first = await firstRun(gitPath);
    const main = mainMoves({ [DERIVED_FILES_TABLE_PATH]: TABLE });
    const job = fixJobOn(first.branch);
    const prepared = await gitPath.prepare(job, FIX_LEASE, newWorkspace("fresh"));
    expect(prepared.updatedTo).toBe(main);
    const mirror = gitPath.mirrorDir?.(job) as string;
    expect(sh("-C", mirror, "cat-file", "-t", main).trim()).toBe("commit");
    const baseFile = createBaseFile(capture, {});
    expect((await readDerivedRules(baseFile, mirror, main)).map((r) => r.id)).toEqual(["api-routes"]);
    // Only the branch's own old tip lacks the table; it is never the pin when the merge happened.
    expect(await readDerivedRules(baseFile, mirror, prepared.base)).toEqual([]);
  });

  it("a branch that already holds the default tip (the cloud merged it): no updatedTo, and checkBase lands on a commit with the table", { timeout: T }, async () => {
    const gitPath = makeGitPath();
    const first = await firstRun(gitPath);
    const main = mainMoves({ [DERIVED_FILES_TABLE_PATH]: TABLE });
    const job = fixJobOn(first.branch);
    const w = newWorkspace("fresh");
    await gitPath.prepare(job, FIX_LEASE, w);
    const merged = tip(w, "HEAD");
    await gitPath.publish(job, FIX_LEASE, w, first.commit);
    const prepared = await gitPath.prepare(job, { runId: randomUUID(), leaseGeneration: 3 }, newWorkspace("again"));
    expect(prepared.updatedTo).toBeUndefined();
    expect(prepared.base).toBe(merged);
    const mirror = gitPath.mirrorDir?.(job) as string;
    const pin = await gitPath.checkBase?.(job, prepared.base);
    expect(pin).toBe(main);
    expect((await readDerivedRules(createBaseFile(capture, {}), mirror, pin as string)).length).toBe(1);
  });

  it("end to end on a continued branch: the table is read at the pin and the committed, regenerated output is lifted", { timeout: T }, async () => {
    const gitPath = makeGitPath();
    const first = await firstRun(gitPath);
    mainMoves({ [DERIVED_FILES_TABLE_PATH]: TABLE, [OPENAPI]: "doc\n", [ROUTE]: "export {};\n" });
    const job = fixJobOn(first.branch);
    const w = newWorkspace("fresh");
    const prepared = await gitPath.prepare(job, FIX_LEASE, w);
    const pin = prepared.updatedTo as string;
    const mirror = gitPath.mirrorDir?.(job) as string;
    put(w, ROUTE, "export const x = 1;\n");
    put(w, OPENAPI, "doc2\n");
    sh("-C", w, "add", "-A");
    sh("-C", w, "commit", "-m", "agent");
    const rules = await readDerivedRules(createBaseFile(capture, {}), mirror, pin);
    const generate = async (argv: readonly string[]): Promise<boolean> => { if (argv[0] === "gen-openapi") put(w, OPENAPI, "doc2\n"); return true; };
    const verdict = await scopeVerdict({
      scope: [ROUTE, "agent.txt"], changedFiles: createChangedFiles(capture, {}), workspace: w, base: pin, rules,
      verifyDerived: (r, paths, changed) => verifyDerivedOutputs({ workspace: w, rules: r, paths, run: generate, dirty: () => createChangedFiles(capture, {})(w, "HEAD"), changed, headBlob: (rel) => createHeadBlob(capture, {})(w, rel), hidden: () => createIndexHidesChanges(capture, {})(w) }),
    });
    expect(verdict).toEqual({ outside: 0, derivedFresh: [OPENAPI] });
  });
});

describe("verifyDerivedOutputs names why nothing was lifted (closed reason codes, real repositories)", () => {
  type Run = (argv: readonly string[]) => Promise<boolean | "nonzero" | "timeout" | "refused">;
  async function setup() {
    const gitPath = makeGitPath();
    const first = await firstRun(gitPath);
    mainMoves({ [DERIVED_FILES_TABLE_PATH]: TABLE, [OPENAPI]: "doc\n", [ROUTE]: "export {};\n" });
    const job = fixJobOn(first.branch);
    const w = newWorkspace("fresh");
    const prepared = await gitPath.prepare(job, FIX_LEASE, w);
    const rules = await readDerivedRules(createBaseFile(capture, {}), gitPath.mirrorDir?.(job) as string, prepared.updatedTo as string);
    put(w, ROUTE, "export const x = 1;\n");
    put(w, OPENAPI, "doc2\n");
    sh("-C", w, "add", "-A");
    sh("-C", w, "commit", "-m", "agent");
    const good: Run = async (argv) => { if (argv[0] === "gen-openapi") put(w, OPENAPI, "doc2\n"); return true; };
    const why = async (run: Run, headBlob?: (rel: string) => Promise<Buffer | null>): Promise<{ fresh: string[]; reasons: string[] }> => {
      const reasons: string[] = [];
      const fresh = await verifyDerivedOutputs({ workspace: w, rules, paths: [OPENAPI], run, dirty: () => createChangedFiles(capture, {})(w, "HEAD"), changed: [ROUTE, OPENAPI], headBlob: headBlob ?? ((rel) => createHeadBlob(capture, {})(w, rel)), hidden: () => createIndexHidesChanges(capture, {})(w), note: (r) => reasons.push(r) });
      return { fresh, reasons };
    };
    return { w, good, why };
  }

  it("a clean, equal tree lifts and notes nothing", { timeout: T }, async () => {
    const { good, why } = await setup();
    expect(await why(good)).toEqual({ fresh: [OPENAPI], reasons: [] });
  });

  it("tree_dirty: an uncommitted file", { timeout: T }, async () => {
    const { w, good, why } = await setup();
    put(w, "stray.txt", "x\n");
    expect(await why(good)).toEqual({ fresh: [], reasons: ["tree_dirty"] });
  });

  it("index_hides: an assume-unchanged entry", { timeout: T }, async () => {
    const { w, good, why } = await setup();
    sh("-C", w, "update-index", "--assume-unchanged", ROUTE);
    expect(await why(good)).toEqual({ fresh: [], reasons: ["index_hides"] });
  });

  it("no_head_blob: HEAD holds no blob for the output", { timeout: T }, async () => {
    const { good, why } = await setup();
    expect(await why(good, async () => null)).toEqual({ fresh: [], reasons: ["no_head_blob"] });
  });

  it("not_equal: the generators reproduce different bytes", { timeout: T }, async () => {
    const { w, why } = await setup();
    const other: Run = async () => { put(w, OPENAPI, "different\n"); return true; };
    expect(await why(other)).toEqual({ fresh: [], reasons: ["not_equal"] });
  });

  it("generator_failed with its exit kind: nonzero, timeout, refused (a throw counts as refused)", { timeout: T }, async () => {
    const { why } = await setup();
    expect((await why(async () => false)).reasons).toEqual(["generator_failed:nonzero"]);
    expect((await why(async () => "timeout")).reasons).toEqual(["generator_failed:timeout"]);
    expect((await why(async () => "refused")).reasons).toEqual(["generator_failed:refused"]);
    expect((await why(async () => { throw new Error("x"); })).reasons).toEqual(["generator_failed:refused"]);
  });
});
