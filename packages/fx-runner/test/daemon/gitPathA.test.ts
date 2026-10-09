import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitTicketResult } from "../../src/daemon/client.js";
import { GitPathError, type GitCapture } from "../../src/daemon/git.js";
import { createGitPathA, type GitPathADeps } from "../../src/daemon/gitPathA.js";
import type { GitJob } from "../../src/daemon/gitPath.js";
import { createGit } from "../../src/daemon/git.js";
import { PUSH_BUDGET_BYTES, assertAllowedChunkRefspec, runPush } from "../../src/daemon/push.js";
import { originHash, gitProxyPinned, gitProxyHashFor, PINNED_GIT_PROXIES } from "../../src/keyring.js";
import { runCapture } from "../../src/engines/claude/capture.js";
import { startRelay, type Relay } from "../helpers/relayFixture.js";

// Cases here run real git several times; under a loaded host (Gate 1 beside other jobs) the 5 s default has been overrun by cases that take well under 1 s alone.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const CLOUD = "https://cloud.example.test";
/** A JWS-shaped string, built from parts at runtime: three base64url segments. */
const makeTicket = (): string => ["hdr", "claims", "sig"].map((part) => Buffer.from(`${part}-${randomBytes(24).toString("hex")}`).toString("base64url")).join(".");

let root: string;
let home: string;
let relay: Relay;
let ticket: string;
let caFile: string;
let helperLog: string;

const SETUP_ENV = (): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: home,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  // `git commit` starts `git maintenance run --auto --detach`, which outlives the command and can create `.git/objects/maintenance.lock` while a test is
  // replacing parts of that `.git`. Nothing in a fixture wants a gc, so both automatic triggers are off (as in workspaceRedirect.test.ts).
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "gc.auto",
  GIT_CONFIG_VALUE_0: "0",
  GIT_CONFIG_KEY_1: "maintenance.auto",
  GIT_CONFIG_VALUE_1: "false",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
});
const sh = (...args: string[]): string => execFileSync("git", args, { env: SETUP_ENV(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const tip = (repo: string, ref: string): string => sh("-C", repo, "rev-parse", ref).trim();
let upstream: string;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-pathA-"));
  home = path.join(root, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  // The user's own credential helper, which records every call. Path A must never reach it.
  helperLog = path.join(root, "helper.log");
  writeFileSync(path.join(home, ".gitconfig"), `[credential]\n\thelper = "!f() { echo called >> ${helperLog}; }; f"\n`);
  upstream = path.join(root, "projects", "acme", "widgets.git");
  mkdirSync(path.dirname(upstream), { recursive: true });
  sh("init", "--bare", "-b", "main", upstream);
  const seed = path.join(root, "seed");
  sh("init", "-b", "main", seed);
  writeFileSync(path.join(seed, "README.md"), "hello\n");
  sh("-C", seed, "add", "README.md");
  sh("-C", seed, "commit", "-m", "first");
  sh("-C", seed, "push", upstream, "main");
  ticket = makeTicket();
  relay = await startRelay({ projectRoot: path.join(root, "projects"), ticket, owner: "acme", name: "widgets" });
  mkdirSync(path.join(root, "not-the-temp-dir"));
  caFile = path.join(root, "ca.pem");
  writeFileSync(caFile, relay.caPem);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

interface Call {
  args: readonly string[];
  env: Record<string, string>;
}

const lease = { runId: "0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f", leaseGeneration: 1 };
const BRANCH = "fx/0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f-g1";
const jobFor = (over: Partial<GitJob> = {}): GitJob => ({ repo: { id: randomUUID(), owner: "acme", name: "widgets", private: true }, continues: null, branch_prefix: "fx/", role: "executor", ...over });

function newWorkspace(name = "run-1"): string {
  const dir = path.join(root, "work", name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
function agentCommit(workspace: string, file: string, bytes: number): string {
  writeFileSync(path.join(workspace, file), randomBytes(bytes));
  sh("-C", workspace, "add", file);
  sh("-C", workspace, "commit", "-m", `add ${file}`);
  return tip(workspace, "HEAD");
}

function makePathA(over: Partial<GitPathADeps> & { mint?: () => Promise<GitTicketResult> } = {}) {
  const calls: Call[] = [];
  const mints: number[] = [];
  const capture: GitCapture = (command, args, env, timeoutMs) => {
    calls.push({ args: [...args], env });
    // The real process start, with the relay's certificate as the only extra trust. Error output kept, as the engine kit keeps it.
    return runCapture(spawn, command, args, { ...env, GIT_SSL_CAINFO: caFile }, timeoutMs, undefined, 2048);
  };
  const mintTicket = vi.fn(async (): Promise<GitTicketResult> => {
    mints.push(calls.length);
    return over.mint ? over.mint() : { kind: "ticket", ticket, expiresAt: "2026-10-08T12:05:00.000Z", proxyOrigin: relay.origin };
  });
  const cacheDir = path.join(root, "cache", "fx-runner");
  const deps: GitPathADeps = {
    capture,
    mirrorsRoot: path.join(cacheDir, "mirrors"),
    stateDir: path.join(root, "state"),
    cloudOrigin: CLOUD,
    platform: "linux",
    mintTicket,
    pinned: { [originHash(CLOUD)!]: originHash(relay.origin)! },
    tmpDir: path.join(root, "not-the-temp-dir"),
    statfs: () => ({ type: 0xef53 }),
    ...over,
  };
  delete (deps as { mint?: unknown }).mint;
  return { gitPath: createGitPathA(deps), calls, mints, mintTicket, mirrorsRoot: deps.mirrorsRoot };
}

const posts = (name: string) => relay.requests.filter((r) => r.method === "POST" && r.path.endsWith(`/${name}`));
/** The pushes themselves: git first sends a body-less probe POST for a large push, which is not one. */
const pushPosts = () => posts("git-receive-pack").filter((r) => (r.updates?.length ?? 0) > 0);
const isPush = (r: { method: string; path: string; updates?: unknown[] }) => r.method === "POST" && r.path.endsWith("/git-receive-pack") && (r.updates?.length ?? 0) > 0;

describe("path A against the real git and a strict relay", () => {
  it("clones, branches, pushes the agent's commit: the ticket header arrives on every request, and the credential helper is never asked", async () => {
    const { gitPath } = makePathA();
    const job = jobFor();
    const workspace = newWorkspace();
    gitPath.check(job, lease);
    const { base } = await gitPath.prepare(job, lease, workspace);
    expect(base).toBe(tip(upstream, "main"));
    const commit = agentCommit(workspace, "agent.txt", 100);
    expect(await gitPath.publish(job, lease, workspace, base)).toEqual({ pushed: true, branch: BRANCH, sha: commit });
    expect(tip(upstream, BRANCH)).toBe(commit);

    expect(relay.requests.length).toBeGreaterThan(3);
    for (const request of relay.requests) {
      expect(request.headers["fx-git-ticket"], `${request.method} ${request.path}`).toBe(ticket);
      expect(request.headers.authorization).toBeUndefined();
      expect(request.status).toBe(200);
    }
    // Real v2 bodies: the first clone asks for objects and has none to offer; the push is one ref update.
    expect(posts("git-upload-pack").some((r) => r.command === "fetch" && (r.wants ?? 0) > 0 && r.haves === 0)).toBe(true);
    expect(posts("git-upload-pack").some((r) => r.command === "ls-refs")).toBe(true);
    expect(pushPosts().map((r) => r.updates)).toEqual([[{ old: "0".repeat(40), new: commit, ref: `refs/heads/${BRANCH}` }]]);
    // The user's helper was set up and never called.
    expect(existsSync(helperLog)).toBe(false);
  });

  it("puts the ticket in the environment only: not in argv, the mirror's config, any file of the mirror or workspace, or an error", async () => {
    const { gitPath, calls, mirrorsRoot } = makePathA();
    const job = jobFor();
    const workspace = newWorkspace();
    const { base } = await gitPath.prepare(job, lease, workspace);
    agentCommit(workspace, "agent.txt", 100);
    await gitPath.publish(job, lease, workspace, base);

    for (const call of calls) expect(call.args.join("\n")).not.toContain(ticket);
    const withTicket = calls.filter((c) => Object.values(c.env).some((v) => v.includes(ticket)));
    expect(withTicket.length).toBeGreaterThan(0);
    // The header is scoped to the relay's address, the helper list is emptied for it, redirects are off and the protocol is v2.
    const pairs = (env: Record<string, string>) => Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
    const config = pairs(withTicket[0]!.env);
    expect(config[`http.${relay.origin}/.extraHeader`]).toBe(`fx-git-ticket: ${ticket}`);
    expect(config[`credential.${relay.origin}/.helper`]).toBe("");
    expect(config["http.followRedirects"]).toBe("false");
    expect(config["protocol.version"]).toBe("2");
    expect(config["core.hooksPath"]).toBe("/dev/null");

    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const file of [...walk(mirrorsRoot), ...walk(workspace)]) expect(readFileSync(file).includes(ticket), file).toBe(false);
    const mirror = path.join(mirrorsRoot, readdirSync(mirrorsRoot)[0]!);
    // The mirror's remote is the relay's address, with no secret in it.
    expect(sh("-C", mirror, "config", "remote.origin.url").trim()).toBe(`${relay.origin}/api/gh-proxy/acme/widgets.git`);

    ticket = "";
    const bad = makePathA({ mint: async () => ({ kind: "ticket", ticket: "aaa.bbb.ccc", expiresAt: "2026-10-08T12:05:00.000Z", proxyOrigin: relay.origin }) });
    const error = await bad.gitPath.prepare(jobFor(), lease, newWorkspace("run-2")).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(GitPathError);
    expect((error as Error).message).not.toContain("aaa.bbb.ccc");
  });

  it("a later sync sends have lines, so it is not a full clone", async () => {
    const { gitPath } = makePathA();
    const job = jobFor();
    await gitPath.prepare(job, lease, newWorkspace("one"));
    const seed = path.join(root, "seed");
    writeFileSync(path.join(seed, "more.txt"), "more\n");
    sh("-C", seed, "add", "more.txt");
    sh("-C", seed, "commit", "-m", "second");
    sh("-C", seed, "push", upstream, "main");
    const before = relay.requests.length;
    await gitPath.prepare(job, { ...lease, leaseGeneration: 2 }, newWorkspace("two"));
    const fetches = relay.requests.slice(before).filter((r) => r.command === "fetch");
    expect(fetches.length).toBe(1);
    expect(fetches[0]!.haves).toBeGreaterThan(0);
  });
});

describe("the proxy must be the pinned one, before any git runs", () => {
  const cases: Array<[string, () => Promise<GitTicketResult>]> = [
    ["another https origin", async () => ({ kind: "ticket", ticket: makeTicket(), expiresAt: "2026-10-08T12:05:00.000Z", proxyOrigin: "https://elsewhere.example.test" })],
    ["an origin with a different port", async () => ({ kind: "ticket", ticket: makeTicket(), expiresAt: "2026-10-08T12:05:00.000Z", proxyOrigin: `https://127.0.0.1:${Number(new URL(relay.origin).port) + 1}` })],
    ["a plain http origin", async () => ({ kind: "ticket", ticket: makeTicket(), expiresAt: "2026-10-08T12:05:00.000Z", proxyOrigin: relay.origin.replace("https:", "http:") })],
  ];
  for (const [name, mint] of cases) {
    it(`${name} is git_proxy_unpinned, with zero git calls and zero requests`, async () => {
      const { gitPath, calls } = makePathA({ mint });
      const job = jobFor();
      for (const step of [() => gitPath.prepare(job, lease, newWorkspace()), () => gitPath.resume(jobFor({ continues: { session_id: "s", branch: BRANCH } as never }), lease, newWorkspace("r"))]) {
        await expect(step()).rejects.toMatchObject({ code: "git_proxy_unpinned" });
      }
      expect(calls).toEqual([]);
      expect(relay.requests).toEqual([]);
    });
  }

  it("a cloud with no pinned proxy is refused by check(), and the table in this build holds hashes only", () => {
    const { gitPath, mintTicket } = makePathA({ pinned: {} });
    expect(() => gitPath.check(jobFor(), lease)).toThrowError(expect.objectContaining({ code: "git_proxy_unpinned" }));
    expect(mintTicket).not.toHaveBeenCalled();
    for (const [cloud, proxy] of Object.entries(PINNED_GIT_PROXIES)) {
      expect(cloud).toMatch(/^[0-9a-f]{64}$/);
      expect(proxy).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(Object.isFrozen(PINNED_GIT_PROXIES)).toBe(true);
    expect(gitProxyHashFor("https://nothing.example.test")).toBeUndefined();
    expect(gitProxyPinned(CLOUD, relay.origin, { [originHash(CLOUD)!]: originHash(relay.origin)! })).toBe(true);
    expect(gitProxyPinned(CLOUD, `${relay.origin}/path`, { [originHash(CLOUD)!]: originHash(relay.origin)! })).toBe(false);
  });
});

describe("path A needs a mirror that lasts", () => {
  const NO_CALLS = async (gitPath: ReturnType<typeof makePathA>): Promise<void> => {
    expect(gitPath.calls).toEqual([]);
    expect(gitPath.mintTicket).not.toHaveBeenCalled();
    expect(relay.requests).toEqual([]);
  };

  it("refuses a mirrors root in the temp directory", async () => {
    const rig = makePathA({ tmpDir: root });
    expect(() => rig.gitPath.check(jobFor(), lease)).toThrowError(expect.objectContaining({ code: "path_a_no_mirror" }));
    await NO_CALLS(rig);
  });

  it("refuses a mirrors root reached through a link into the temp directory", async () => {
    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere);
    const temp = path.join(root, "tmp-like");
    mkdirSync(path.join(temp, "inner"), { recursive: true });
    const cacheDir = path.join(root, "linked");
    symlinkSync(path.join(temp, "inner"), cacheDir);
    const rig = makePathA({ tmpDir: temp, mirrorsRoot: path.join(cacheDir, "mirrors") });
    expect(() => rig.gitPath.check(jobFor(), lease)).toThrowError(expect.objectContaining({ code: "path_a_no_mirror" }));
    await NO_CALLS(rig);
  });

  for (const [name, type] of [["tmpfs", 0x01021994], ["ramfs", 0x858458f6]] as const) {
    it(`refuses a mirrors root on ${name}`, async () => {
      const rig = makePathA({ statfs: () => ({ type }) });
      expect(() => rig.gitPath.check(jobFor(), lease)).toThrowError(expect.objectContaining({ code: "path_a_no_mirror" }));
      await NO_CALLS(rig);
    });
  }

  it("refuses a file system it cannot ask about, and accepts an ordinary one", async () => {
    const rig = makePathA({ statfs: () => { throw new Error("no"); } });
    expect(() => rig.gitPath.check(jobFor(), lease)).toThrowError(expect.objectContaining({ code: "path_a_no_mirror" }));
    expect(() => makePathA().gitPath.check(jobFor(), lease)).not.toThrow();
    // The memory check is Linux's: another platform is not asked.
    expect(() => makePathA({ platform: "darwin", statfs: () => ({ type: 0x01021994 }) }).gitPath.check(jobFor(), lease)).not.toThrow();
  });
});

describe("a push is cut to fit the proxy's cap, and goes whole or not at all", () => {
  it("three commits of 3 MB each give three pushes, in order, one ref each, no +", async () => {
    const { gitPath, calls } = makePathA();
    const job = jobFor();
    const workspace = newWorkspace();
    const { base } = await gitPath.prepare(job, lease, workspace);
    const commits = [agentCommit(workspace, "a.bin", 3_000_000), agentCommit(workspace, "b.bin", 3_000_000), agentCommit(workspace, "c.bin", 3_000_000)];
    expect(await gitPath.publish(job, lease, workspace, base)).toEqual({ pushed: true, branch: BRANCH, sha: commits[2] });
    expect(pushPosts().map((r) => r.updates)).toEqual(commits.map((sha, i) => [{ old: i === 0 ? "0".repeat(40) : commits[i - 1], new: sha, ref: `refs/heads/${BRANCH}` }]));
    for (const request of pushPosts()) expect(request.body.length).toBeLessThan(PUSH_BUDGET_BYTES + 65_536);
    expect(tip(upstream, BRANCH)).toBe(commits[2]);
    const pushes = calls.filter((c) => c.args.includes("push"));
    expect(pushes.length).toBe(3);
    for (const push of pushes) {
      expect(push.args.some((a) => a.startsWith("+") || a === "--force" || a === "--force-with-lease")).toBe(false);
      expect(push.args).toContain("--atomic");
      expect(push.args[push.args.length - 1]).toMatch(new RegExp(`^[0-9a-f]{40}:refs/heads/${BRANCH}$`));
    }
    expect(commits.map((c) => pushes.findIndex((p) => p.args.at(-1)!.startsWith(c)))).toEqual([0, 1, 2]);
  });

  it("commits that fit together go in one push, with the plain private-ref refspec", async () => {
    const { gitPath, calls } = makePathA();
    const job = jobFor();
    const workspace = newWorkspace();
    const { base } = await gitPath.prepare(job, lease, workspace);
    agentCommit(workspace, "a.bin", 1_000_000);
    const last = agentCommit(workspace, "b.bin", 1_000_000);
    expect((await gitPath.publish(job, lease, workspace, base)).pushed).toBe(true);
    expect(pushPosts().length).toBe(1);
    expect(calls.filter((c) => c.args.includes("push")).map((c) => c.args.at(-1))).toEqual([`refs/fx-push/${lease.runId}-g1:refs/heads/${BRANCH}`]);
    expect(tip(upstream, BRANCH)).toBe(last);
  });

  it("one 5 MB commit gives zero pushes and push_too_large with size_mb 5", async () => {
    const { gitPath, calls } = makePathA();
    const job = jobFor();
    const workspace = newWorkspace();
    const { base } = await gitPath.prepare(job, lease, workspace);
    agentCommit(workspace, "small.txt", 100);
    agentCommit(workspace, "huge.bin", 5_000_000);
    const error = await gitPath.publish(job, lease, workspace, base).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "push_too_large", sizeMb: 5 });
    expect(pushPosts()).toEqual([]);
    expect(calls.some((c) => c.args.includes("push"))).toBe(false);
    expect(sh("-C", upstream, "for-each-ref", "refs/heads/fx").trim()).toBe("");
  });

  it("a failing chunk is tried twice more with a fresh ticket each time, then push_incomplete; the first chunk stays landed", async () => {
    const { gitPath, mints } = makePathA();
    const job = jobFor();
    const workspace = newWorkspace();
    const { base } = await gitPath.prepare(job, lease, workspace);
    const commits = [agentCommit(workspace, "a.bin", 3_000_000), agentCommit(workspace, "b.bin", 3_000_000)];
    relay.script.before = (req) => (isPush(req) && pushPosts().length > 1 ? 500 : undefined);
    const mintsBefore = mints.length;
    await expect(gitPath.publish(job, lease, workspace, base)).rejects.toMatchObject({ code: "push_incomplete" });
    expect(pushPosts().length).toBe(1 + 3);
    expect(mints.length - mintsBefore).toBe(1 + 3);
    expect(tip(upstream, BRANCH)).toBe(commits[0]);
  });

  it("stops at once, with no retry, when the relay says the lease is over", async () => {
    const { gitPath } = makePathA();
    const job = jobFor();
    const workspace = newWorkspace();
    const { base } = await gitPath.prepare(job, lease, workspace);
    agentCommit(workspace, "a.bin", 3_000_000);
    agentCommit(workspace, "b.bin", 3_000_000);
    relay.script.before = (req) => (isPush(req) ? 409 : undefined);
    await expect(gitPath.publish(job, lease, workspace, base)).rejects.toMatchObject({ code: "git_stopped" });
    expect(pushPosts().length).toBe(1);
  });

  it("asks for no more pushes once the lease has been stopped", async () => {
    const { gitPath } = makePathA();
    const job = jobFor();
    const workspace = newWorkspace();
    const { base } = await gitPath.prepare(job, lease, workspace);
    agentCommit(workspace, "a.bin", 3_000_000);
    agentCommit(workspace, "b.bin", 3_000_000);
    let stopped = false;
    relay.script.before = (req) => {
      if (isPush(req)) stopped = true;
      return undefined;
    };
    expect(await gitPath.publish(job, lease, workspace, base, () => stopped)).toEqual({ pushed: false });
    expect(pushPosts().length).toBe(1);
  });

  it("a role that does not push pushes nothing", async () => {
    const { gitPath, mintTicket } = makePathA();
    const job = jobFor({ role: "code-reviewer" });
    expect(await gitPath.publish(job, lease, newWorkspace(), "a".repeat(40))).toEqual({ pushed: false });
    expect(mintTicket).not.toHaveBeenCalled();
  });
});

describe("what git reports of the relay's answer is mapped to a closed code", () => {
  it("409 on the first request is git_stopped", async () => {
    relay.script.before = () => 409;
    await expect(makePathA().gitPath.prepare(jobFor(), lease, newWorkspace())).rejects.toMatchObject({ code: "git_stopped" });
  });

  it("a ticket the relay refuses is git_revoked, and the user's credential helper is still not asked", async () => {
    relay.ticket.value = makeTicket();
    await expect(makePathA().gitPath.prepare(jobFor(), lease, newWorkspace())).rejects.toMatchObject({ code: "git_revoked" });
    expect(existsSync(helperLog)).toBe(false);
  });

  it("429 on the first clone is clone_limited, and no mirror is left behind", async () => {
    relay.script.before = () => 429;
    const rig = makePathA();
    await expect(rig.gitPath.prepare(jobFor(), lease, newWorkspace())).rejects.toMatchObject({ code: "clone_limited" });
    expect(existsSync(rig.mirrorsRoot) ? readdirSync(rig.mirrorsRoot) : []).toEqual([]);
  });

  it("413 on a push is push_too_large (the backstop), with no size", async () => {
    const { gitPath } = makePathA();
    const job = jobFor();
    const workspace = newWorkspace();
    const { base } = await gitPath.prepare(job, lease, workspace);
    agentCommit(workspace, "a.txt", 100);
    relay.script.before = (req) => (req.method === "POST" && req.path.endsWith("/git-receive-pack") ? 413 : undefined);
    const error = await gitPath.publish(job, lease, workspace, base).catch((e: unknown) => e as GitPathError);
    expect(error).toMatchObject({ code: "push_too_large" });
    expect((error as GitPathError).sizeMb).toBeUndefined();
  });

  it("the ticket's own failures: a stop is git_stopped, a revoked runner git_revoked, a refusal git_ticket_refused, with no git call", async () => {
    const answers: Array<[GitTicketResult, string]> = [
      [{ kind: "stop", reason: "stale_generation" }, "git_stopped"],
      [{ kind: "error", status: 401 }, "git_revoked"],
      [{ kind: "error", status: 403, code: "not_cloud_verified" }, "git_ticket_refused"],
      [{ kind: "error", status: 503 }, "git_ticket_refused"],
      [{ kind: "error", status: 0 }, "git_ticket_refused"],
    ];
    for (const [answer, code] of answers) {
      const { gitPath, calls } = makePathA({ mint: async () => answer });
      await expect(gitPath.prepare(jobFor(), lease, newWorkspace()), code).rejects.toMatchObject({ code });
      expect(calls).toEqual([]);
    }
  });

  it("a ticket older than 240 s is replaced before the next command of the same stretch of work", async () => {
    let clock = 1_000_000;
    // Every look at the clock is 100 s later, so a sync of several commands outlives one ticket.
    const { gitPath, mintTicket } = makePathA({ now: () => (clock += 100_000) });
    await gitPath.prepare(jobFor(), lease, newWorkspace());
    expect(mintTicket.mock.calls.length).toBeGreaterThan(1);
    for (const request of relay.requests) expect(request.headers["fx-git-ticket"]).toBe(ticket);
  });
});

describe("a chunk's refspec is the plan's branch and a commit between the run's base and its tip, and nothing else", () => {
  it("refuses every other source and target, and a + or a second ref", async () => {
    const repo = path.join(root, "chunks");
    sh("init", "-b", "main", repo);
    const commit = (name: string): string => {
      writeFileSync(path.join(repo, name), name);
      sh("-C", repo, "add", name);
      sh("-C", repo, "commit", "-m", name);
      return tip(repo, "HEAD");
    };
    const base = commit("base");
    const mid = commit("mid");
    const top = commit("top");
    sh("-C", repo, "checkout", "-q", "--detach", base);
    const stray = commit("stray"); // a commit that is not on the run's line
    const calls: string[][] = [];
    const git = createGit({ capture: (command, args, env, timeoutMs) => (calls.push([...args]), runCapture(spawn, command, args, { ...env, ...SETUP_ENV() }, timeoutMs)) });
    const bounds = { base, sha: top };
    const target = `refs/heads/${BRANCH}`;
    await assertAllowedChunkRefspec(git, repo, `${mid}:${target}`, lease, null, bounds);
    await assertAllowedChunkRefspec(git, repo, `${top}:${target}`, lease, null, bounds);
    const refused: Array<[string, string]> = [
      ["another branch", `${mid}:refs/heads/main`],
      ["a tag", `${mid}:refs/tags/x`],
      ["a forced update", `+${mid}:${target}`],
      ["a symbolic source", `main:${target}`],
      ["an abbreviated id", `${mid.slice(0, 12)}:${target}`],
      ["a second ref", `${mid}:${target}:refs/heads/main`],
      ["a commit not on the run's line", `${stray}:${target}`],
      ["a deletion", `:${target}`],
    ];
    for (const [name, refspec] of refused) {
      await expect(assertAllowedChunkRefspec(git, repo, refspec, lease, null, bounds), name).rejects.toMatchObject({ code: "push_ref_refused" });
    }
    // Through runPush: the refusal comes before any push process is started.
    const before = calls.length;
    await expect(runPush(git, repo, "https://relay.example.test/x.git", `${mid}:refs/heads/main`, lease, null, bounds)).rejects.toMatchObject({ code: "push_ref_refused" });
    expect(calls.slice(before).some((args) => args.includes("push"))).toBe(false);
  });
});
