import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MachineJob as MachineJobSchema, type MachineJob } from "@fulcrumaxe/runner-protocol";
import type { RunnerClient } from "../../src/daemon/client.js";
import { createGit, type Git } from "../../src/daemon/git.js";
import type { Step, StepReporter } from "../../src/daemon/machineJobs.js";
import { createTwinSeedHandler } from "../../src/setup/twinSeed.js";
import { RUNNER_BUILD_CAPABILITIES } from "../../src/version.js";
import { jobOf } from "../helpers/machineJobFixture.js";
import { startGitHttpServer, type GitHttpServer } from "../helpers/gitHttpServer.js";
import { GIT_ENV, fixtureRepo, git, scratchDir } from "../vm/workspace/helpers.js";

/**
 * D#845 ON-27b: the runner's twin seed, against REAL git and a smart-HTTP git server that stands in for github.com: reads are anonymous, a push needs the one token of the twin and no other repository (the real host's rule
 * for an installation token). The cloud's token route and GitHub's revoke are stand-ins that record what they were asked. What this cannot show: GitHub's push rules and limits, and TLS (a loopback http origin is the one
 * place the transport allows plain http).
 */
const TOKEN = "ghs_sentinel_twin_seed_token_41c7d09e2b";
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

async function world(o: { twinBranch?: string; tokenFor?: string[] } = {}) {
  const fx = fixtureRepo((dir) => {
    // a Git LFS pointer, copied as the pointer it is
    writeFileSync(path.join(dir, "big.bin"), "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a".repeat(64) + "\nsize 123456\n");
  });
  const root = scratchDir("fxw-twin-");
  const bare = (name: string): string => {
    const dir = path.join(root, "acme", `${name}.git`);
    mkdirSync(path.dirname(dir), { recursive: true });
    git(root, "init", "-q", "--bare", dir);
    git(dir, "config", "http.receivepack", "true");
    return dir;
  };
  const pub = bare("widgets");
  const twin = bare("widgets-private");
  git(fx.repo, "push", "-q", pub, "HEAD:refs/heads/main");
  git(fx.repo, "branch", "other");
  git(fx.repo, "tag", "v1");
  git(fx.repo, "push", "-q", pub, "refs/heads/other", "refs/tags/v1");
  if (o.twinBranch !== undefined) git(fx.repo, "push", "-q", twin, `HEAD:refs/heads/${o.twinBranch}`);
  const server = await startGitHttpServer(root, new Map([[TOKEN, o.tokenFor ?? ["acme/widgets-private"]]]));
  servers.push(server);
  const scratchRoot = scratchDir("fxw-twin-scratch-");
  const argv: string[][] = [];
  const base = realGit();
  const traced: Git = { run: (code, args, config, timeoutMs, extraEnv) => (argv.push([...args]), base.run(code, args, config, timeoutMs, extraEnv)) };
  const asked: Array<{ setupId: string; jobId: string }> = [];
  const revoked: string[] = [];
  const client: Pick<RunnerClient, "setupPushToken"> = {
    async setupPushToken(setupId, jobId) {
      asked.push({ setupId, jobId });
      return o.tokenFor?.length === 0 ? { kind: "refused", status: 409, code: "already_issued" } : { kind: "token", token: TOKEN, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    },
  };
  const handlerFor = (extra: { maxPackBytes?: number } = {}) => createTwinSeedHandler({ git: traced, client, revoke: async (t) => (revoked.push(t), true), scratchRoot, remoteUrl: (repo) => `${server.origin}/${repo.owner}/${repo.name}.git`, ...extra });
  const head = git(fx.repo, "rev-parse", "HEAD");
  const job = (over: { repo_gh_id?: number; head_sha?: string; pub?: Record<string, unknown>; prv?: Record<string, unknown> } = {}): MachineJob => {
    const body = {
      ...jobOf({ kind: "twin_seed", repo_gh_id: over.repo_gh_id ?? 2 }),
      args: {
        twin_id: "4f1b8a52-2d3c-4e5f-8a6b-7c8d9e0f1a2b",
        public: { owner: "acme", name: "widgets", gh_id: 1, default_branch: "main", head_sha: over.head_sha ?? head, ...over.pub },
        private: { owner: "acme", name: "widgets-private", gh_id: 2, ...over.prv },
      },
    };
    return body as unknown as MachineJob;
  };
  return { fx, root, pub, twin, server, scratchRoot, argv, asked, revoked, handlerFor, head, job };
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

const run = async (w: Awaited<ReturnType<typeof world>>, job: MachineJob, extra: { maxPackBytes?: number } = {}) => {
  const r = reporterOf();
  await w.handlerFor(extra)({ job: MachineJobSchema.parse(job) as never, reporter: r.reporter as never, signal: new AbortController().signal });
  return r.steps;
};
const refs = (repo: string): string[] => git(repo, "for-each-ref", "--format=%(refname) %(objectname)").split("\n").filter((l) => l !== "").sort();

describe("the seed", () => {
  it("copies the default branch at the signed commit, and only that: no tag, no other branch, the LFS pointer as a pointer", async () => {
    const w = await world();
    const job = w.job();
    const steps = await run(w, job);
    expect(steps).toEqual([
      { sub_step: "twin_fetch", state: "started" },
      { sub_step: "twin_fetch", state: "ok" },
      { sub_step: "push", state: "started" },
      { sub_step: "push", state: "ok", head_sha: w.head },
    ]);
    expect(refs(w.twin)).toEqual([`refs/heads/main ${w.head}`]);
    expect(git(w.twin, "rev-parse", "main^{tree}")).toBe(git(w.pub, "rev-parse", "main^{tree}"));
    expect(git(w.twin, "show", "main:big.bin")).toContain("version https://git-lfs.github.com/spec/v1");
    // the public repository was only read, anonymously
    const publicRequests = w.server.seen.filter((r) => r.path.startsWith("/acme/widgets.git/"));
    expect(publicRequests.length).toBeGreaterThan(0);
    for (const r of publicRequests) {
      expect(r.authorization).toBeUndefined();
      expect(r.path).not.toContain("git-receive-pack");
    }
    // every write to the twin carried its one token
    const pushes = w.server.seen.filter((r) => r.path.includes("git-receive-pack"));
    expect(pushes.length).toBeGreaterThan(0);
    for (const p of pushes) {
      expect(p.path.startsWith("/acme/widgets-private.git/")).toBe(true);
      expect(p.authorization).toBe(`Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`);
    }
    expect(w.asked).toEqual([{ setupId: job.setup_id, jobId: job.job_id }]);
    expect(w.revoked).toEqual([TOKEN]);
    expect(readdirSync(w.scratchRoot)).toEqual([]);
  }, 60_000);

  it("never forces the push, sends no tags, and never puts the token in an argument", async () => {
    const w = await world();
    await run(w, w.job());
    const pushes = w.argv.filter((a) => a.includes("push"));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain("--no-follow-tags");
    expect(pushes[0]!.some((a) => /force|^\+|--mirror|--tags|--all/.test(a))).toBe(false);
    expect(pushes[0]!.at(-1)).toBe("refs/fx-twin/head:refs/heads/main");
    expect(JSON.stringify(w.argv)).not.toContain(TOKEN);
  }, 60_000);

  it("fetches with no hook and no tag, from github.com's shape of address only", async () => {
    const w = await world();
    await run(w, w.job());
    const fetches = w.argv.filter((a) => a.includes("fetch"));
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toEqual(expect.arrayContaining(["--no-tags", "--no-recurse-submodules"]));
    expect(fetches[0]!.at(-1)).toBe("+refs/heads/main:refs/fx-twin/head");
  }, 60_000);
});

describe("the refusals", () => {
  it("a public tip that is not the signed commit is twin_head_moved, with no token asked for and nothing written", async () => {
    const w = await world();
    git(w.fx.repo, "commit", "-q", "--allow-empty", "-m", "later");
    git(w.fx.repo, "push", "-q", w.pub, "HEAD:refs/heads/main");
    const steps = await run(w, w.job());
    expect(steps.at(-1)).toEqual({ sub_step: "twin_fetch", state: "failed", failure_code: "twin_head_moved", failure_reason: "tip" });
    expect(w.asked).toEqual([]);
    expect(refs(w.twin)).toEqual([]);
    expect(readdirSync(w.scratchRoot)).toEqual([]);
  }, 60_000);

  it("objects over the limit are twin_too_large, before any token", async () => {
    const w = await world();
    const steps = await run(w, w.job(), { maxPackBytes: 1 });
    expect(steps.at(-1)).toEqual({ sub_step: "twin_fetch", state: "failed", failure_code: "twin_too_large", failure_reason: "pack" });
    expect(w.asked).toEqual([]);
    expect(refs(w.twin)).toEqual([]);
  }, 60_000);

  it("a twin that has any branch is twin_not_empty: nothing is pushed and the token is revoked", async () => {
    const w = await world({ twinBranch: "dev" });
    const before = refs(w.twin);
    const steps = await run(w, w.job());
    expect(steps.at(-1)).toEqual({ sub_step: "push", state: "failed", failure_code: "twin_not_empty", failure_reason: "has_branch" });
    expect(refs(w.twin)).toEqual(before);
    expect(w.revoked).toEqual([TOKEN]);
    expect(w.server.seen.filter((r) => r.path.includes("git-receive-pack") && r.method === "POST")).toEqual([]);
  }, 60_000);

  it("a token the cloud refuses is push_failed, and a repository that cannot be read is twin_fetch_failed", async () => {
    const refused = await world({ tokenFor: [] });
    expect((await run(refused, refused.job())).at(-1)).toEqual({ sub_step: "push", state: "failed", failure_code: "push_failed", failure_reason: "token_refused" });
    expect(refs(refused.twin)).toEqual([]);
    const missing = await world();
    const steps = await run(missing, missing.job({ pub: { name: "no-such-repo" } }));
    expect(steps.at(-1)).toMatchObject({ sub_step: "twin_fetch", state: "failed", failure_code: "twin_fetch_failed" });
    expect(missing.asked).toEqual([]);
  }, 60_000);

  it("a token that covers the public repository is never used on it: a push there is refused by the host and the handler never tries", async () => {
    const w = await world({ tokenFor: ["acme/widgets-private"] });
    await run(w, w.job());
    expect(w.server.seen.filter((r) => r.path.startsWith("/acme/widgets.git/") && r.authorization !== undefined)).toEqual([]);
    expect(git(w.pub, "for-each-ref", "--format=%(refname)").split("\n").sort()).toEqual(["refs/heads/main", "refs/heads/other", "refs/tags/v1"]);
  }, 60_000);

  it("a job that names the public repository as its own target is stopped before any network call (the schema refuses it too)", async () => {
    const w = await world();
    const bad = w.job({ repo_gh_id: 1 });
    expect(MachineJobSchema.safeParse(bad).success).toBe(false);
    const r = reporterOf();
    await w.handlerFor()({ job: bad as never, reporter: r.reporter as never, signal: new AbortController().signal });
    expect(r.steps.at(-1)).toEqual({ sub_step: "twin_fetch", state: "failed", failure_code: "push_failed", failure_reason: "target" });
    expect(w.asked).toEqual([]);
    expect(w.server.seen).toEqual([]);
  }, 60_000);
});

describe("what the build advertises", () => {
  it("twin_v1 is not in the capabilities a runner build lists, so no runner is offered a twin job yet", () => {
    expect(RUNNER_BUILD_CAPABILITIES as string[]).not.toContain("twin_v1");
  });
});
