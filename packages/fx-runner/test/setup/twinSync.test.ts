import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MachineJob as MachineJobSchema, type MachineJob } from "@fulcrumaxe/runner-protocol";
import type { RunnerClient } from "../../src/daemon/client.js";
import { createGit, type Git } from "../../src/daemon/git.js";
import type { Step, StepReporter } from "../../src/daemon/machineJobs.js";
import { TWIN_SYNC_IDENTITY, createTwinSyncHandler, privatePatternsOf } from "../../src/setup/twinSync.js";
import { RUNNER_BUILD_CAPABILITIES } from "../../src/version.js";
import { jobOf } from "../helpers/machineJobFixture.js";
import { startGitHttpServer, type GitHttpServer } from "../helpers/gitHttpServer.js";
import { GIT_ENV, git, scratchDir } from "../vm/workspace/helpers.js";

/**
 * D#845 ON-27d2: the runner's twin sync, against REAL git and a smart-HTTP git server that stands in for github.com: reads are anonymous, a push needs the one token of the twin and no other repository (the real host's rule for an
 * installation token). The twin's mirror is a real bare clone read through its object directory, as the runner's own mirror is. The cloud's token route and GitHub's revoke are stand-ins that record what they were asked.
 * What this cannot show: GitHub's push rules and limits, and TLS (a loopback http origin is the one place the transport allows plain http).
 */
const TOKEN = "ghs_sentinel_twin_sync_token_9d21c4e07a";
const TWIN_ID = "4f1b8a52-2d3c-4e5f-8a6b-7c8d9e0f1a2b";
const servers: GitHttpServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const realGit = (): Git =>
  createGit({
    capture: (command, args, env) =>
      new Promise((resolve) => {
        execFile(command, [...args], { env: { ...GIT_ENV(), ...env }, encoding: "utf8", maxBuffer: 1 << 26 }, (error, stdout) =>
          resolve({ code: error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1, stdout, timedOut: false }),
        );
      }),
  });

const SET = { overlay_globs: ["docs/plan/**"], install_paths: [".github/workflows/engine.yml"], blob_globs: [] as string[], identifier_rules_path: null as string | null, plan_data_rules_path: null as string | null };
const put = (dir: string, file: string, text: string | Buffer, mode?: number): void => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
  if (mode !== undefined) chmodSync(path.join(dir, file), mode);
};
const commit = (dir: string, message: string): string => (git(dir, "add", "-A"), git(dir, "commit", "-q", "--allow-empty", "-m", message), git(dir, "rev-parse", "HEAD"));

interface Opts {
  /** The twin's private working copy, before the sync. */
  twin?: (dir: string) => void;
  /** The public repository's later work. */
  pub?: (dir: string) => void;
  set?: Partial<typeof SET>;
  token?: "ok" | "refused" | "pairing_changed";
  maxPackBytes?: number;
  /** Rewrites the arguments of a git command just before it runs (a test's way of showing the guards that sit behind git's own behaviour). */
  rewrite?: (args: string[]) => string[];
}

async function world(o: Opts = {}) {
  const root = scratchDir("fxw-tsync-");
  const bare = (name: string): string => {
    const dir = path.join(root, "acme", `${name}.git`);
    mkdirSync(path.dirname(dir), { recursive: true });
    git(root, "init", "-q", "--bare", dir);
    git(dir, "config", "http.receivepack", "true");
    return dir;
  };
  const pubRepo = bare("widgets");
  const twinRepo = bare("widgets-private");
  // the twin: its own history, with private files that never belong to the public repository
  const priv = path.join(root, "priv");
  git(root, "init", "-q", priv);
  put(priv, "README.md", "hello\n");
  put(priv, "src/a.ts", "export const a = 1;\n");
  put(priv, "src/aX.ts", "export const decoy = 1;\n");
  put(priv, "run.sh", "#!/bin/sh\necho ok\n", 0o755);
  put(priv, "docs/plan/roadmap.md", "private roadmap\n");
  put(priv, ".autonomous-team/notes.md", "private notes\n");
  put(priv, ".github/workflows/engine.yml", "name: engine\n");
  put(priv, "gone.txt", "will be deleted publicly\n");
  put(priv, "swap", "a file the public replaces with a directory\n");
  o.twin?.(priv);
  const base = commit(priv, "twin base");
  git(priv, "push", "-q", twinRepo, "HEAD:refs/heads/main");
  const mirror = path.join(root, "mirror.git");
  git(root, "clone", "-q", "--bare", twinRepo, mirror);
  // the public repository: the same code, then its own later work
  const pub = path.join(root, "pub");
  git(root, "clone", "-q", "-b", "main", twinRepo, pub);
  git(pub, "rm", "-q", "-r", "--cached", "docs/plan", ".autonomous-team", ".github");
  rmSync(path.join(pub, "docs/plan"), { recursive: true, force: true });
  rmSync(path.join(pub, ".autonomous-team"), { recursive: true, force: true });
  rmSync(path.join(pub, ".github"), { recursive: true, force: true });
  put(pub, "src/a.ts", "export const a = 2; // the public change\n");
  put(pub, "src/b.ts", "export const b = 1;\n");
  put(pub, "docs/guide.md", "public guide\n");
  put(pub, "tool.sh", "#!/bin/sh\necho tool\n", 0o755);
  git(pub, "rm", "-q", "gone.txt");
  git(pub, "rm", "-q", "swap");
  put(pub, "swap/inside.txt", "now a directory\n");
  o.pub?.(pub);
  const tip = commit(pub, "a stranger's commit");
  git(pub, "push", "-q", pubRepo, "HEAD:refs/heads/main");
  git(pub, "push", "-q", pubRepo, "HEAD:refs/heads/other");
  const server = await startGitHttpServer(root, new Map([[TOKEN, ["acme/widgets-private"]]]));
  servers.push(server);
  const scratchRoot = path.join(scratchDir("fxw-tsync-work-"), "twin-sync");
  const argv: string[][] = [];
  const base0 = realGit();
  // What the scratch repository could see of the twin when the anonymous fetch ran: the alternates file, and whether the twin's base commit resolved.
  const atFetch: Array<{ alternates: boolean; baseVisible: boolean }> = [];
  const traced: Git = {
    run: async (code, args, config, timeoutMs, extraEnv) => {
      const sent = o.rewrite === undefined ? [...args] : o.rewrite([...args]);
      argv.push(sent);
      if (sent.includes("fetch") && sent[0] === "-C") {
        const baseVisible = await base0.run(code, ["-C", sent[1]!, "cat-file", "-e", `${base}^{commit}`]).then(
          () => true,
          () => false,
        );
        atFetch.push({ alternates: existsSync(path.join(sent[1]!, "objects", "info", "alternates")), baseVisible });
      }
      return base0.run(code, sent, config, timeoutMs, extraEnv);
    },
  };
  const asked: Array<{ setupId: string; jobId: string }> = [];
  const revoked: string[] = [];
  const synced: Array<{ id: string; owner: string; name: string }> = [];
  const client: Pick<RunnerClient, "setupPushToken"> = {
    async setupPushToken(setupId, jobId) {
      asked.push({ setupId, jobId });
      if (o.token === "refused") return { kind: "refused", status: 409, code: "already_issued" };
      if (o.token === "pairing_changed") return { kind: "refused", status: 409, code: "pairing_changed" };
      return { kind: "token", token: TOKEN, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    },
  };
  const mirrorBase = { value: base };
  const handler = () =>
    createTwinSyncHandler({
      git: traced,
      mirrors: { sync: async (repo) => (synced.push(repo), { dir: mirror, base: mirrorBase.value }), objects: () => path.join(mirror, "objects") },
      client,
      revoke: async (t) => (revoked.push(t), true),
      scratchRoot,
      remoteUrl: (repo) => `${server.origin}/${repo.owner}/${repo.name}.git`,
      ...(o.maxPackBytes === undefined ? {} : { maxPackBytes: o.maxPackBytes }),
    });
  const job = (over: { paths?: string[]; args?: Record<string, unknown>; jobOver?: Record<string, unknown>; private_set?: Record<string, unknown> } = {}): MachineJob =>
    ({
      ...jobOf({ kind: "twin_sync", repo_gh_id: 2 }),
      args: {
        twin_id: TWIN_ID,
        public: { owner: "acme", name: "widgets", gh_id: 1, tip },
        private: { owner: "acme", name: "widgets-private", gh_id: 2, base },
        branch: `fx/twin-sync-${tip.slice(0, 12)}`,
        paths: over.paths ?? ["src/a.ts", "src/b.ts", "docs/guide.md", "tool.sh", "gone.txt", "swap", "swap/inside.txt"],
        private_set: { ...SET, ...o.set, ...over.private_set },
        ...over.args,
      },
      ...over.jobOver,
    }) as unknown as MachineJob;
  return { root, priv, pub, pubRepo, twinRepo, mirror, server, scratchRoot, argv, atFetch, asked, revoked, synced, mirrorBase, handler, base, tip, job };
}

function reporterOf(): { reporter: StepReporter; steps: Step[] } {
  const steps: Step[] = [];
  let closed = false;
  const reporter: StepReporter = {
    get closed() {
      return closed;
    },
    async report(step) {
      if (closed) return "closed";
      steps.push(step);
      if (step.state === "failed" || (step.state === "ok" && step.head_sha !== undefined)) closed = true;
      return "recorded";
    },
  };
  return { reporter, steps };
}

type World = Awaited<ReturnType<typeof world>>;
const run = async (w: World, job: MachineJob = w.job()) => {
  const r = reporterOf();
  await w.handler()({ job: MachineJobSchema.parse(job) as never, reporter: r.reporter as never, signal: new AbortController().signal });
  return r.steps;
};
const refs = (repo: string): string[] => git(repo, "for-each-ref", "--format=%(refname) %(objectname)").split("\n").filter((l) => l !== "").sort();
/** What is left in the runner's scratch directory (nothing, and not even the directory when the job stopped before it was needed). */
const leftovers = (w: World): string[] => (existsSync(w.scratchRoot) ? readdirSync(w.scratchRoot) : []);
const pushes = (w: World): string[] => w.server.seen.filter((r) => r.path.includes("git-receive-pack") && r.method === "POST").map((r) => r.path);
/** Nothing was sent anywhere, no credential was asked for, and nothing is left on this machine. */
const nothingSent = (w: World, twinBefore: string[]): void => {
  expect(refs(w.twinRepo)).toEqual(twinBefore);
  expect(pushes(w)).toEqual([]);
  expect(w.asked).toEqual([]);
  expect(leftovers(w)).toEqual([]);
};

describe("the sync", () => {
  it("sets exactly the listed paths to the public tip's blobs in ONE commit on the twin's tip, pushed to its own branch and nothing else", async () => {
    const w = await world();
    const job = w.job();
    const before = refs(w.twinRepo);
    const steps = await run(w, job);
    const branch = `fx/twin-sync-${w.tip.slice(0, 12)}`;
    const commitSha = git(w.twinRepo, "rev-parse", branch);
    expect(steps).toEqual([
      { sub_step: "twin_fetch", state: "started" },
      { sub_step: "twin_fetch", state: "ok" },
      { sub_step: "push", state: "started" },
      { sub_step: "push", state: "ok", head_sha: commitSha },
    ]);
    // one commit with one parent, the twin's tip; the twin's main did not move; only the one branch was added
    expect(git(w.twinRepo, "rev-list", "--parents", "-n", "1", branch)).toBe(`${commitSha} ${w.base}`);
    expect(refs(w.twinRepo)).toEqual([...before, `refs/heads/${branch} ${commitSha}`].sort());
    // the paths are the public blobs (with the executable bit), the removed ones are gone, a file became a directory
    const show = (file: string): string => git(w.twinRepo, "show", `${branch}:${file}`);
    expect(show("src/a.ts")).toContain("the public change");
    expect(show("src/b.ts")).toBe("export const b = 1;");
    expect(show("docs/guide.md")).toBe("public guide");
    expect(git(w.twinRepo, "ls-tree", branch, "tool.sh")).toMatch(/^100755 blob /);
    expect(git(w.twinRepo, "ls-tree", "-r", "--name-only", branch).split("\n")).not.toContain("gone.txt");
    expect(git(w.twinRepo, "ls-tree", branch, "swap")).toMatch(/^040000 tree /);
    // everything that was not listed is the twin's own, byte for byte: the private files, the decoy beside a listed name, the readme the public repository dropped
    expect(git(w.twinRepo, "diff-tree", "-r", "--name-only", w.base, commitSha).split("\n").sort()).toEqual(["docs/guide.md", "gone.txt", "src/a.ts", "src/b.ts", "swap", "swap/inside.txt", "tool.sh"]);
    for (const kept of ["docs/plan/roadmap.md", ".autonomous-team/notes.md", ".github/workflows/engine.yml", "src/aX.ts", "README.md"]) expect(git(w.twinRepo, "rev-parse", `${branch}:${kept}`), kept).toBe(git(w.twinRepo, "rev-parse", `${w.base}:${kept}`));
    // the commit has the platform's identity, the job's time and the fixed message; nothing of the public authors or its history
    expect(git(w.twinRepo, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%at|%s", branch)).toBe(`${TWIN_SYNC_IDENTITY.name} <${TWIN_SYNC_IDENTITY.email}>|${TWIN_SYNC_IDENTITY.name} <${TWIN_SYNC_IDENTITY.email}>|${Math.floor(Date.parse((job as { issued_at: string }).issued_at) / 1000)}|Bring in changes made on the public repository`);
    expect(() => git(w.twinRepo, "cat-file", "-e", w.tip)).toThrow();
    expect(git(w.twinRepo, "cat-file", "commit", branch)).not.toMatch(/stranger/);
    // the twin's mirror was asked for by its own id; the credential once, for this job, and revoked
    expect(w.synced).toEqual([{ id: "2", owner: "acme", name: "widgets-private" }]);
    expect(w.asked).toEqual([{ setupId: job.setup_id, jobId: job.job_id }]);
    expect(w.revoked).toEqual([TOKEN]);
    // the public repository was only read, anonymously; every write went to the twin with the one token
    const publicRequests = w.server.seen.filter((r) => r.path.startsWith("/acme/widgets.git/"));
    expect(publicRequests.length).toBeGreaterThan(0);
    for (const r of publicRequests) {
      expect(r.authorization).toBeUndefined();
      expect(r.path).not.toContain("git-receive-pack");
    }
    const writes = w.server.seen.filter((r) => r.path.includes("git-receive-pack"));
    expect(writes.length).toBeGreaterThan(0);
    for (const p of writes) {
      expect(p.path.startsWith("/acme/widgets-private.git/")).toBe(true);
      expect(p.authorization).toBe(`Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`);
    }
    expect(refs(w.pubRepo).map((l) => l.split(" ")[0])).toEqual(["refs/heads/main", "refs/heads/other"]);
    expect(leftovers(w)).toEqual([]);
  }, 60_000);

  it("never forces the push, sends no tags, and never puts the token in an argument; every git command reads paths literally and the fetch takes no hook, tag or submodule", async () => {
    const w = await world();
    await run(w);
    const pushArgs = w.argv.filter((a) => a.includes("push"));
    expect(pushArgs).toHaveLength(1);
    expect(pushArgs[0]).toContain("--no-follow-tags");
    expect(pushArgs[0]!.some((a) => /force|^\+|--mirror|--tags|--all|--delete/.test(a))).toBe(false);
    expect(pushArgs[0]!.at(-1)).toMatch(/^[0-9a-f]{40}:refs\/heads\/fx\/twin-sync-[0-9a-f]{12}$/);
    expect(JSON.stringify(w.argv)).not.toContain(TOKEN);
    const fetches = w.argv.filter((a) => a.includes("fetch"));
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toEqual(expect.arrayContaining(["--no-tags", "--no-recurse-submodules"]));
    expect(fetches[0]!.at(-1)).toBe("+refs/heads/main:refs/fx-sync/public");
    // no path of the job is ever an argument that could be read as an option or a pattern: the path commands put `--` before it, the cacheinfo carries it after a mode and a sha
    const pathCommands = w.argv.filter((a) => a.includes("ls-tree") || a.includes("--force-remove"));
    expect(pathCommands.length).toBeGreaterThan(0);
    for (const a of pathCommands) expect(a.at(-2)).toBe("--");
  }, 60_000);

  it("the anonymous fetch sees none of the twin: no alternates file and the twin's commits do not resolve while it runs, and they are attached afterwards", async () => {
    const w = await world();
    const steps = await run(w);
    expect(w.atFetch).toEqual([{ alternates: false, baseVisible: false }]);
    expect(steps.at(-1)).toMatchObject({ sub_step: "push", state: "ok" });
    // the same private state in both runs: the commit still builds on the twin's tip, so the objects were attached after the fetch
    expect(git(w.twinRepo, "rev-list", "--parents", "-n", "1", `fx/twin-sync-${w.tip.slice(0, 12)}`)).toMatch(new RegExp(` ${w.base}$`));
  }, 60_000);

  it("reads a path literally: a glob-looking name matches nothing, so a decoy it would have matched is never touched", async () => {
    const w = await world({ pub: (dir) => put(dir, "src/aX.ts", "export const decoy = 2; // changed in public\n") });
    const before = refs(w.twinRepo);
    const steps = await run(w, w.job({ paths: ["src/a*.ts", "src/a?.ts", "src/[a].ts"] }));
    expect(steps.at(-1)).toEqual({ sub_step: "twin_fetch", state: "failed", failure_code: "no_changes", failure_reason: "equal" });
    nothingSent(w, before);
  }, 60_000);

  it("is the same commit every time for the same job, so a push that landed and was not reported is not an error", async () => {
    const w = await world();
    const job = w.job();
    const first = await run(w, job);
    const second = await run(w, job);
    expect(second.at(-1)).toEqual(first.at(-1));
    expect(pushes(w)).toHaveLength(1);
    expect(w.revoked).toEqual([TOKEN, TOKEN]);
  }, 60_000);
});

describe("the refusals: each one pushes nothing", () => {
  it("a path of the private set is private_path_change before anything is read: a fixed root, a person's glob, an install path, a rule file, a secret default", async () => {
    for (const [file, set] of [
      [".autonomous-team/notes.md", {}],
      ["docs/plan/roadmap.md", {}],
      [".github/workflows/engine.yml", {}],
      ["config/rules.txt", { identifier_rules_path: "config/rules.txt" }],
      ["server.pem", {}],
      ["DOCS/PLAN/Roadmap.md", {}],
    ] as const) {
      const w = await world({ set });
      const before = refs(w.twinRepo);
      const steps = await run(w, w.job({ paths: ["src/a.ts", file] }));
      expect(steps, file).toEqual([{ sub_step: "twin_fetch", state: "failed", failure_code: "private_path_change", failure_reason: "private" }]);
      expect(w.server.seen, file).toEqual([]);
      expect(w.synced, file).toEqual([]);
      nothingSent(w, before);
    }
  }, 120_000);

  it("a path the public tip makes a symlink, a submodule or a file over 8 MB is sync_unsafe_path", async () => {
    const link = await world({ pub: (dir) => (rmSync(path.join(dir, "src/b.ts"), { force: true }), symlinkSync("../README.md", path.join(dir, "src/b.ts"))) });
    expect((await run(link)).at(-1)).toEqual({ sub_step: "twin_fetch", state: "failed", failure_code: "sync_unsafe_path", failure_reason: "mode" });
    nothingSent(link, refs(link.twinRepo).filter((l) => !l.includes("fx/twin-sync")));
    const module = await world({
      pub: (dir) => {
        mkdirSync(path.join(dir, "sub"));
        git(path.join(dir, "sub"), "init", "-q");
        put(dir, "sub/x.txt", "x\n");
        git(path.join(dir, "sub"), "add", "-A");
        git(path.join(dir, "sub"), "commit", "-q", "-m", "inner");
      },
    });
    expect((await run(module, module.job({ paths: ["sub"] }))).at(-1)).toEqual({ sub_step: "twin_fetch", state: "failed", failure_code: "sync_unsafe_path", failure_reason: "mode" });
    const big = await world({ pub: (dir) => put(dir, "src/b.ts", Buffer.alloc(8 * 1024 * 1024 + 1, 97)) });
    expect((await run(big)).at(-1)).toEqual({ sub_step: "twin_fetch", state: "failed", failure_code: "sync_unsafe_path", failure_reason: "size" });
    expect(big.asked).toEqual([]);
    expect(pushes(big)).toEqual([]);
    // the same size, exactly at the limit, is copied
    const edge = await world({ pub: (dir) => put(dir, "src/b.ts", Buffer.alloc(8 * 1024 * 1024, 97)) });
    expect((await run(edge)).at(-1)).toMatchObject({ sub_step: "push", state: "ok" });
  }, 120_000);

  it("a file that became a directory (or the reverse) without both paths listed is a conflict, never a silent removal of the twin's entries", async () => {
    const w = await world();
    const before = refs(w.twinRepo);
    // `swap` is a file on the twin and a directory on the public tip: listing only the file's side would need `swap/inside.txt` too, and listing only the new file would drop nothing
    const steps = await run(w, w.job({ paths: ["swap/inside.txt"] }));
    expect(steps.at(-1)).toEqual({ sub_step: "twin_fetch", state: "failed", failure_code: "sync_unsafe_path", failure_reason: "conflict" });
    nothingSent(w, before);
  }, 60_000);

  // On a Mac, `core.precomposeunicode` rewrites a decomposed (NFD) argv path to its composed form before git sees it, so the path git records can differ from the one the job listed. These two checks on the finished tree are then the only guard.
  const moveCacheinfo = (to: string) => (args: string[]): string[] => args.map((a) => (a.endsWith(",src/a.ts") && args.includes("--cacheinfo") ? `${a.slice(0, -"src/a.ts".length)}${to}` : a));
  it("a path git records that the private set covers, though it was not the one listed, is private_path_change and sends nothing", async () => {
    const w = await world({ rewrite: moveCacheinfo("docs/plan/roadmap.md") });
    const before = refs(w.twinRepo);
    const steps = await run(w);
    expect(w.argv.some((a) => a.includes("--cacheinfo") && a.some((x) => x.endsWith(",docs/plan/roadmap.md")))).toBe(true);
    expect(steps.at(-1)).toEqual({ sub_step: "twin_fetch", state: "failed", failure_code: "private_path_change", failure_reason: "private" });
    nothingSent(w, before);
  }, 60_000);

  it("a path git records that was not listed (and is not private) is bad_input and sends nothing", async () => {
    const w = await world({ rewrite: moveCacheinfo("src/aX.ts") });
    const before = refs(w.twinRepo);
    const steps = await run(w);
    expect(w.argv.some((a) => a.includes("--cacheinfo") && a.some((x) => x.endsWith(",src/aX.ts")))).toBe(true);
    expect(steps.at(-1)).toEqual({ sub_step: "twin_fetch", state: "failed", failure_code: "bad_input", failure_reason: "outside" });
    nothingSent(w, before);
  }, 60_000);

  it("a public tip that is not the signed one is public_tip_moved, and a twin tip that is not the signed base is private_tip_moved: no token, nothing written", async () => {
    const moved = await world();
    git(moved.pub, "commit", "-q", "--allow-empty", "-m", "later");
    git(moved.pub, "push", "-q", moved.pubRepo, "HEAD:refs/heads/main");
    const before = refs(moved.twinRepo);
    expect((await run(moved)).at(-1)).toEqual({ sub_step: "twin_fetch", state: "failed", failure_code: "public_tip_moved", failure_reason: "tip" });
    nothingSent(moved, before);
    const twin = await world();
    twin.mirrorBase.value = "9".repeat(40);
    expect((await run(twin)).at(-1)).toEqual({ sub_step: "twin_fetch", state: "failed", failure_code: "private_tip_moved", failure_reason: "base" });
    expect(twin.server.seen).toEqual([]);
    expect(twin.asked).toEqual([]);
  }, 120_000);

  it("a public repository that cannot be read is public_unavailable, and a mirror that cannot be had is twin_fetch_failed", async () => {
    const missing = await world();
    expect((await run(missing, missing.job({ args: { public: { owner: "acme", name: "no-such-repo", gh_id: 1, tip: missing.tip } } }))).at(-1)).toMatchObject({ sub_step: "twin_fetch", state: "failed", failure_code: "public_unavailable" });
    expect(missing.asked).toEqual([]);
    const broken = await world();
    const r = reporterOf();
    const handler = createTwinSyncHandler({ git: realGit(), mirrors: { sync: async () => Promise.reject(new Error("/some/path: no such mirror")), objects: () => "/nowhere" }, client: { setupPushToken: async () => ({ kind: "refused", status: 409 }) }, revoke: async () => true, scratchRoot: broken.scratchRoot, remoteUrl: (repo) => `${broken.server.origin}/${repo.owner}/${repo.name}.git` });
    await handler({ job: MachineJobSchema.parse(broken.job()) as never, reporter: r.reporter as never, signal: new AbortController().signal });
    expect(r.steps.at(-1)).toEqual({ sub_step: "twin_fetch", state: "failed", failure_code: "twin_fetch_failed", failure_reason: "mirror" });
    expect(JSON.stringify(r.steps)).not.toContain("/some/path");
    expect(leftovers(broken)).toEqual([]);
  }, 120_000);

  it("objects over the limit are twin_too_large, before any token", async () => {
    const w = await world({ maxPackBytes: 1 });
    const before = refs(w.twinRepo);
    expect((await run(w)).at(-1)).toEqual({ sub_step: "twin_fetch", state: "failed", failure_code: "twin_too_large", failure_reason: "pack" });
    nothingSent(w, before);
  }, 60_000);

  it("paths whose blobs are the twin's own already (what it published came back) are no_changes: nothing is sent and no token is asked for", async () => {
    const w = await world({ pub: (dir) => put(dir, "src/a.ts", "export const a = 1;\n") });
    const before = refs(w.twinRepo);
    const steps = await run(w, w.job({ paths: ["src/a.ts", "README.md"] }));
    expect(steps.at(-1)).toEqual({ sub_step: "twin_fetch", state: "failed", failure_code: "no_changes", failure_reason: "equal" });
    nothingSent(w, before);
  }, 60_000);

  it("a branch that exists at another commit is branch_exists: nothing is pushed over it and the token is revoked", async () => {
    const w = await world();
    const branch = `fx/twin-sync-${w.tip.slice(0, 12)}`;
    git(w.priv, "push", "-q", w.twinRepo, `HEAD:refs/heads/${branch}`);
    const before = refs(w.twinRepo);
    expect((await run(w)).at(-1)).toEqual({ sub_step: "push", state: "failed", failure_code: "branch_exists", failure_reason: "exists" });
    expect(refs(w.twinRepo)).toEqual(before);
    expect(w.revoked).toEqual([TOKEN]);
    expect(pushes(w)).toEqual([]);
  }, 60_000);

  it("a token the cloud refuses is push_failed, a changed private set is pairing_changed, and neither pushes anything", async () => {
    const refused = await world({ token: "refused" });
    expect((await run(refused)).at(-1)).toEqual({ sub_step: "push", state: "failed", failure_code: "push_failed", failure_reason: "token_refused" });
    expect(pushes(refused)).toEqual([]);
    const changed = await world({ token: "pairing_changed" });
    expect((await run(changed)).at(-1)).toEqual({ sub_step: "push", state: "failed", failure_code: "pairing_changed", failure_reason: "set" });
    expect(pushes(changed)).toEqual([]);
    expect(refs(changed.twinRepo).some((l) => l.includes("fx/twin-sync"))).toBe(false);
    expect(leftovers(changed)).toEqual([]);
  }, 120_000);

  it("a token that covers the public repository is never used on it: the handler never writes there", async () => {
    const w = await world();
    await run(w);
    expect(w.server.seen.filter((r) => r.path.startsWith("/acme/widgets.git/") && r.authorization !== undefined)).toEqual([]);
  }, 60_000);

  it("a job that names the public repository as its home, a branch that is not the tip's or a path that is not plain is stopped before any network call (the schema refuses them too)", async () => {
    const w = await world();
    for (const bad of [w.job({ jobOver: { repo_gh_id: 1 } }), w.job({ args: { branch: "fx/twin-sync-000000000000" } }), w.job({ paths: ["a/../b"] }), w.job({ paths: [".git/config"] })]) {
      expect(MachineJobSchema.safeParse(bad).success).toBe(false);
      const r = reporterOf();
      await w.handler()({ job: bad as never, reporter: r.reporter as never, signal: new AbortController().signal });
      expect(r.steps.at(-1)).toEqual({ sub_step: "twin_fetch", state: "failed", failure_code: "bad_input", failure_reason: "target" });
    }
    expect(w.server.seen).toEqual([]);
    expect(w.asked).toEqual([]);
  }, 60_000);
});

describe("what the build advertises, and where the set comes from", () => {
  it("twin_v1 is the last capability a runner build lists (D#845 ON-27d4c), and run.ts registers all three twin handlers", () => {
    // D#845 ON-19c: `gh_login_v1` is newer and goes after it; the order is checked by index, never from the end.
    expect((RUNNER_BUILD_CAPABILITIES as string[]).indexOf("twin_v1")).toBe((RUNNER_BUILD_CAPABILITIES as string[]).indexOf("gh_login_v1") - 1);
  });

  it("the private patterns come from the signed job alone: the fixed roots, the person's globs, the install paths and the two rule files", () => {
    const job = MachineJobSchema.parse({
      ...jobOf({ kind: "twin_sync", repo_gh_id: 2 }),
      args: { twin_id: TWIN_ID, public: { owner: "acme", name: "widgets", gh_id: 1, tip: "a".repeat(40) }, private: { owner: "acme", name: "widgets-private", gh_id: 2, base: "b".repeat(40) }, branch: `fx/twin-sync-${"a".repeat(12)}`, paths: ["x"], private_set: { ...SET, identifier_rules_path: "r/ids.txt", plan_data_rules_path: "r/plan.json" } },
    });
    expect(privatePatternsOf(job as never)).toEqual(expect.arrayContaining([".autonomous-team/**", "CLAUDE.md", "docs/plan/**", ".github/workflows/engine.yml", "r/ids.txt", "r/plan.json"]));
  });
});
