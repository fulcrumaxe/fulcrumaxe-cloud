import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MachineJob as MachineJobSchema, TWIN_FIXED_PRIVATE, buildTwinPublishText, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { createGitTransport } from "@fulcrumaxe/runner-protocol/planePush";
import type { RunnerClient } from "../../src/daemon/client.js";
import type { Step, StepReporter } from "../../src/daemon/machineJobs.js";
import { TWIN_PUBLISH_IDENTITY, createTwinPublishHandler, pairingOf } from "../../src/setup/twinPublish.js";
import { RUNNER_BUILD_CAPABILITIES } from "../../src/version.js";
import { jobOf } from "../helpers/machineJobFixture.js";
import { startGitHttpServer, type GitHttpServer } from "../helpers/gitHttpServer.js";
import { fixtureRepo, git, scratchDir } from "../vm/workspace/helpers.js";

/**
 * D#845 ON-27c2: the runner's twin publish, against REAL git, D#598's real push route in export mode and a smart-HTTP git server that stands in for github.com (reads are anonymous; a push needs the one token of the public repository
 * and no other). The cloud's token route and GitHub's pull request API are stand-ins that enforce what the real ones do for these calls (a token for one repository; a pull request needs a pushed branch on the tip). What this cannot
 * show: GitHub's push rules and limits, and TLS (a loopback http origin is the one place the transport allows plain http).
 */
const TOKEN = "ghs_sentinel_twin_publish_token_6b21d90a";
const PRIVATE_TITLE = "D#845 Fix the billing leak for acme-corp";
const TWIN_ID = "4f1b8a52-2d3c-4e5f-8a6b-7c8d9e0f1a2b";
const servers: GitHttpServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const SET = { overlay_globs: ["docs/plan/**"], install_paths: [".github/workflows/engine.yml"], blob_globs: [] as string[], identifier_rules_path: null as string | null, plan_data_rules_path: null as string | null };

interface Opts {
  refuse?: { status: number; code?: string } | undefined;
  set?: Partial<typeof SET>;
  /** Writes the twin's later work into the private working copy before it is committed. */
  changes?: (dir: string) => void;
}

async function world(o: Opts = {}) {
  const fx = fixtureRepo();
  const base = fx.commit;
  const root = scratchDir("fxw-tpub-");
  const bare = (name: string): string => {
    const dir = path.join(root, "acme", `${name}.git`);
    mkdirSync(path.dirname(dir), { recursive: true });
    git(root, "init", "-q", "--bare", dir);
    git(dir, "config", "http.receivepack", "true");
    return dir;
  };
  const pub = bare("widgets");
  git(fx.repo, "push", "-q", pub, "HEAD:refs/heads/main");
  const put = (file: string, text: string): void => {
    mkdirSync(path.dirname(path.join(fx.repo, file)), { recursive: true });
    writeFileSync(path.join(fx.repo, file), text);
  };
  if (o.changes !== undefined) o.changes(fx.repo);
  else {
    put("src/new.ts", "export const added = 2;\n");
    put("README.md", "hello, again\n");
    put(".autonomous-team/notes.md", "private plan\n");
    put("docs/plan/roadmap.md", "private roadmap\n");
    put(".github/workflows/engine.yml", "name: engine\n");
  }
  git(fx.repo, "add", "-A");
  git(fx.repo, "commit", "-q", "-m", PRIVATE_TITLE);
  const head = git(fx.repo, "rev-parse", "HEAD");
  const mirror = path.join(root, "private-mirror.git");
  git(root, "clone", "-q", "--bare", fx.repo, mirror);
  const server = await startGitHttpServer(root, new Map([[TOKEN, ["acme/widgets"]]]));
  servers.push(server);
  const workRoot = path.join(scratchDir("fxw-tpub-work-"), "twin-publish");
  const asked: Array<{ setupId: string; jobId: string }> = [];
  const revoked: string[] = [];
  const opened: Array<{ codeRepo: string; branch: string; base: string; title: string; body: string; token: string }> = [];
  const syncs: Array<{ id: string; owner: string; name: string }> = [];
  const client: Pick<RunnerClient, "setupPushToken"> = {
    async setupPushToken(setupId, jobId) {
      asked.push({ setupId, jobId });
      return o.refuse !== undefined ? { kind: "refused" as const, status: o.refuse.status as 404 | 409 | 502, ...(o.refuse.code === undefined ? {} : { code: o.refuse.code }) } : { kind: "token", token: TOKEN, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    },
  };
  /** GitHub's side of the three calls the route makes, held to what the real one does: the token must be the public repository's. */
  const github = {
    async branchExists(i: { codeRepo: string; branch: string; token: string }) {
      expect(i.token).toBe(TOKEN);
      return git(pub, "for-each-ref", `refs/heads/${i.branch}`, "--format=%(refname)") !== "";
    },
    async branchHead(i: { codeRepo: string; branch: string; token: string }) {
      return git(pub, "for-each-ref", `refs/heads/${i.branch}`, "--format=%(objectname)") || null;
    },
    async openPullRequest(i: { codeRepo: string; branch: string; base: string; title: string; body: string; token: string }) {
      expect(i.token).toBe(TOKEN);
      expect(i.codeRepo).toBe("acme/widgets");
      expect(git(pub, "for-each-ref", `refs/heads/${i.branch}`, "--format=%(objectname)")).not.toBe("");
      opened.push(i);
      return { number: 7, url: "https://github.com/acme/widgets/pull/7" };
    },
    revokeToken: async (t: string) => (revoked.push(t), true),
  };
  const handler = createTwinPublishHandler({
    mirrors: { sync: async (repo) => (syncs.push(repo), { dir: mirror, base: head }) },
    client,
    github,
    transport: createGitTransport({ origin: server.origin }),
    workRoot,
  });
  const pubTip = git(pub, "rev-parse", "main");
  const job = (over: Record<string, unknown> = {}, jobOver: Record<string, unknown> = {}): MachineJob =>
    ({
      ...jobOf({ kind: "twin_publish", repo_gh_id: 2 }),
      args: {
        twin_id: TWIN_ID,
        public: { owner: "acme", name: "widgets", gh_id: 1, tip: pubTip },
        private: { owner: "acme", name: "widgets-private", gh_id: 2, base, head },
        branch: `fx/publish-${head.slice(0, 12)}`,
        private_set: { ...SET, ...o.set },
        ...over,
      },
      ...jobOver,
    }) as unknown as MachineJob;
  return { fx, root, pub, mirror, server, workRoot, asked, revoked, opened, syncs, handler, base, head, pubTip, job };
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
      if (step.state === "failed" || (step.sub_step === "pr_open" && step.state === "ok")) closed = true;
      return "recorded";
    },
  };
  return { reporter, steps };
}

const run = async (w: Awaited<ReturnType<typeof world>>, job: MachineJob = w.job()) => {
  const r = reporterOf();
  await w.handler({ job: MachineJobSchema.parse(job) as never, reporter: r.reporter as never, signal: new AbortController().signal });
  return r.steps;
};
const refs = (repo: string): string[] => git(repo, "for-each-ref", "--format=%(refname) %(objectname)").split("\n").filter((l) => l !== "").sort();
const pushesTo = (w: Awaited<ReturnType<typeof world>>): string[] => w.server.seen.filter((r) => r.path.includes("git-receive-pack") && r.method === "POST").map((r) => r.path);
const nothingSent = (w: Awaited<ReturnType<typeof world>>, before: string[]): void => {
  expect(refs(w.pub)).toEqual(before);
  expect(pushesTo(w)).toEqual([]);
  expect(w.opened).toEqual([]);
  expect(readdirSync(w.workRoot)).toEqual([]);
};

describe("the publish", () => {
  it("sends the change as one commit on the public tip with the private paths dropped, and opens one pull request with the fixed text", async () => {
    const w = await world();
    const job = w.job();
    const steps = await run(w, job);
    const branch = `fx/publish-${w.head.slice(0, 12)}`;
    const commit = git(w.pub, "rev-parse", branch);
    expect(steps).toEqual([
      { sub_step: "twin_fetch", state: "started" },
      { sub_step: "twin_fetch", state: "ok" },
      { sub_step: "push", state: "started" },
      { sub_step: "push", state: "ok", head_sha: commit },
      { sub_step: "pr_open", state: "ok" },
    ]);
    // one commit, one parent: the public main tip. The private history is not in the public repository.
    expect(git(w.pub, "rev-list", "--parents", "-n", "1", branch)).toBe(`${commit} ${w.pubTip}`);
    expect(Number(git(w.pub, "rev-list", "--count", branch))).toBe(Number(git(w.pub, "rev-list", "--count", "main")) + 1);
    // the public tree has the public changes and none of the private set: a fixed root, a person's glob, the install's exact path
    const tree = git(w.pub, "ls-tree", "-r", "--name-only", branch).split("\n");
    expect(tree).toContain("src/new.ts");
    expect(git(w.pub, "show", `${branch}:README.md`)).toBe("hello, again");
    for (const secret of [".autonomous-team/notes.md", "docs/plan/roadmap.md", ".github/workflows/engine.yml"]) expect(tree, secret).not.toContain(secret);
    // public main did not move; only the one branch was added
    expect(refs(w.pub)).toEqual([`refs/heads/${branch} ${commit}`, `refs/heads/main ${w.pubTip}`].sort());
    // the commit carries the platform's identity and the template's title, and nothing of the private side's
    expect(git(w.pub, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%s", branch)).toBe(`${TWIN_PUBLISH_IDENTITY.name} <${TWIN_PUBLISH_IDENTITY.email}>|${TWIN_PUBLISH_IDENTITY.name} <${TWIN_PUBLISH_IDENTITY.email}>|${w.opened[0]!.title}`);
    // exactly the template: the count of merged changes, the date of the job, the paths that are published
    const expected = buildTwinPublishText({ commits: 1, date: (job as { issued_at: string }).issued_at.slice(0, 10), paths: ["README.md", "src/new.ts"] });
    expect(w.opened).toEqual([{ codeRepo: "acme/widgets", branch, base: "main", title: expected.title, body: expected.body, token: TOKEN }]);
    for (const text of [JSON.stringify(w.opened), git(w.pub, "log", "-1", "--format=%B", branch), git(w.pub, "cat-file", "commit", branch)]) {
      expect(text).not.toMatch(/D#845|billing|acme-corp|widgets-private|private title|4f1b8a52|roadmap|notes\.md/i);
    }
    // the private repository was asked for by its own id, and the credential was asked for once, for this job, and revoked
    expect(w.syncs).toEqual([{ id: "2", owner: "acme", name: "widgets-private" }]);
    expect(w.asked).toEqual([{ setupId: job.setup_id, jobId: job.job_id }]);
    expect(w.revoked).toEqual([TOKEN]);
    // every write carried the one token, and went to the public repository alone
    const writes = w.server.seen.filter((r) => r.path.includes("git-receive-pack"));
    expect(writes.length).toBeGreaterThan(0);
    for (const p of writes) {
      expect(p.path.startsWith("/acme/widgets.git/")).toBe(true);
      expect(p.authorization).toBe(`Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`);
    }
    // the public tip was read anonymously, and no throwaway repository is left
    for (const r of w.server.seen.filter((x) => !x.path.includes("git-receive-pack"))) expect(r.authorization).toBeUndefined();
    expect(readdirSync(w.workRoot)).toEqual([]);
  }, 60_000);

  it("takes the private set from the signed job alone: the fixed roots, the person's globs and the install's exact paths", () => {
    const job = MachineJobSchema.parse({
      ...jobOf({ kind: "twin_publish", repo_gh_id: 2 }),
      args: {
        twin_id: TWIN_ID,
        public: { owner: "acme", name: "widgets", gh_id: 1, tip: "a".repeat(40) },
        private: { owner: "acme", name: "widgets-private", gh_id: 2, base: "a".repeat(40), head: "c".repeat(40) },
        branch: `fx/publish-${"c".repeat(12)}`,
        private_set: { ...SET, blob_globs: ["assets/**"], identifier_rules_path: ".autonomous-team/ids.txt" },
      },
    });
    expect(pairingOf(job as never)).toEqual({ enabled: true, codeRepo: "acme/widgets", overlayGlobs: [...TWIN_FIXED_PRIVATE, "docs/plan/**", ".github/workflows/engine.yml"], identifierRulesPath: ".autonomous-team/ids.txt", planDataRulesPath: null, binaryGlobs: ["assets/**"] });
  });
});

describe("the refusals: each one pushes nothing", () => {
  it("a line that looks like a credential is scan_refused by place and rule, before any token is asked for", async () => {
    const w = await world({ changes: (dir) => writeFileSync(path.join(dir, "config.ts"), `export const key = "ghs_${"A1b2C3d4E5".repeat(4)}";\n`) });
    const before = refs(w.pub);
    const steps = await run(w);
    expect(steps.at(-1)).toMatchObject({ sub_step: "push", state: "failed", failure_code: "scan_refused", failure_reason: "secret_shaped" });
    expect(w.asked).toEqual([]);
    nothingSent(w, before);
  }, 60_000);

  it("a change that touches only private paths is no_changes: nothing is sent and the cloud moves the anchor", async () => {
    const w = await world({ changes: (dir) => (mkdirSync(path.join(dir, ".autonomous-team"), { recursive: true }), writeFileSync(path.join(dir, ".autonomous-team", "only.md"), "private\n")) });
    const before = refs(w.pub);
    const steps = await run(w);
    expect(steps.at(-1)).toMatchObject({ sub_step: "push", state: "failed", failure_code: "no_changes" });
    expect(w.asked).toEqual([]);
    nothingSent(w, before);
  }, 60_000);

  it("a public main that is not the tip the job was signed against is public_tip_moved, with no token and nothing written", async () => {
    const w = await world();
    const before = refs(w.pub);
    const steps = await run(w, w.job({ public: { owner: "acme", name: "widgets", gh_id: 1, tip: "e".repeat(40) } }));
    expect(steps.at(-1)).toMatchObject({ sub_step: "push", state: "failed", failure_code: "public_tip_moved" });
    expect(w.asked).toEqual([]);
    nothingSent(w, before);
  }, 60_000);

  it("a set that changed since the issue is pairing_changed: the cloud mints nothing, the runner pushes nothing and has nothing to revoke", async () => {
    const w = await world({ refuse: { status: 409, code: "pairing_changed" } });
    const before = refs(w.pub);
    const steps = await run(w);
    expect(steps.at(-1)).toMatchObject({ sub_step: "push", state: "failed", failure_code: "pairing_changed" });
    expect(w.asked).toHaveLength(1);
    expect(w.revoked).toEqual([]);
    nothingSent(w, before);
  }, 60_000);

  it("any other refusal of the credential is public_unavailable, and an unknown code is never passed on", async () => {
    const w = await world({ refuse: { status: 409, code: "something_made_up" } });
    const before = refs(w.pub);
    expect((await run(w)).at(-1)).toMatchObject({ sub_step: "push", state: "failed", failure_code: "public_unavailable" });
    nothingSent(w, before);
  }, 60_000);

  it("an overlay that does not compile is scan_refused and nothing is fetched from the public repository or sent to it", async () => {
    const w = await world({ set: { overlay_globs: ["docs/[plan]/**"] } });
    const before = refs(w.pub);
    const steps = await run(w);
    expect(steps.at(-1)).toMatchObject({ failure_code: "scan_refused", failure_reason: "overlay_invalid", state: "failed" });
    expect(w.asked).toEqual([]);
    expect(w.server.seen).toEqual([]);
    nothingSent(w, before);
  }, 60_000);

  it("a declared rule file that no private path covers is rule_files_not_private; one that is covered but cannot be read refuses too", async () => {
    const uncovered = await world({ set: { identifier_rules_path: "rules/ids.txt" } });
    const before = refs(uncovered.pub);
    expect((await run(uncovered)).at(-1)).toMatchObject({ state: "failed", failure_code: "rule_files_not_private" });
    nothingSent(uncovered, before);
    const missing = await world({ set: { identifier_rules_path: ".autonomous-team/ids.txt" } });
    const beforeMissing = refs(missing.pub);
    expect((await run(missing)).at(-1)).toMatchObject({ state: "failed", failure_code: "scan_refused" });
    expect(missing.asked).toEqual([]);
    nothingSent(missing, beforeMissing);
  }, 60_000);

  it("a branch that already exists on the public repository is branch_exists: it is never pushed over, and the credential is revoked", async () => {
    const w = await world();
    const branch = `fx/publish-${w.head.slice(0, 12)}`;
    git(w.fx.repo, "push", "-q", w.pub, `${w.base}:refs/heads/${branch}`);
    const before = refs(w.pub);
    const steps = await run(w);
    expect(steps.at(-1)).toMatchObject({ sub_step: "push", state: "failed", failure_code: "branch_exists" });
    expect(w.revoked).toEqual([TOKEN]);
    nothingSent(w, before);
  }, 60_000);

  it("a mirror that cannot be read is twin_fetch_failed and the base that is not an ancestor of the head is base_not_ancestor", async () => {
    const w = await world();
    const before = refs(w.pub);
    const swapped = w.job({ private: { owner: "acme", name: "widgets-private", gh_id: 2, base: w.head, head: w.base }, branch: `fx/publish-${w.base.slice(0, 12)}` });
    expect((await run(w, swapped)).at(-1)).toMatchObject({ sub_step: "twin_fetch", state: "failed", failure_code: "base_not_ancestor" });
    const missing = w.job({ private: { owner: "acme", name: "widgets-private", gh_id: 2, base: w.base, head: "d".repeat(40) }, branch: `fx/publish-${"d".repeat(12)}` });
    expect((await run(w, missing)).at(-1)).toMatchObject({ sub_step: "twin_fetch", state: "failed", failure_code: "twin_fetch_failed" });
    expect(w.asked).toEqual([]);
    nothingSent(w, before);
  }, 60_000);

  it("a job that names the public repository as its home is stopped before any network call (the schema refuses it too)", async () => {
    const w = await world();
    const bad = w.job({}, { repo_gh_id: 1 });
    expect(MachineJobSchema.safeParse(bad).success).toBe(false);
    const r = reporterOf();
    await w.handler({ job: bad as never, reporter: r.reporter as never, signal: new AbortController().signal });
    expect(r.steps.at(-1)).toEqual({ sub_step: "twin_fetch", state: "failed", failure_code: "bad_input", failure_reason: "target" });
    expect(w.asked).toEqual([]);
    expect(w.syncs).toEqual([]);
    expect(w.server.seen).toEqual([]);
  }, 60_000);
});

describe("what the build advertises", () => {
  it("twin_v1 is not in the capabilities a runner build lists, so no runner is offered a twin publish yet", () => {
    expect(RUNNER_BUILD_CAPABILITIES as string[]).not.toContain("twin_v1");
  });
});
