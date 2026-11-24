import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_BASE_COMMIT, type MachineJobOf } from "@fulcrumaxe/runner-protocol";
import { createSetupRepos } from "../../src/setup/setupRepos.js";
import { pushSetup, type SetupPushInput } from "../../src/setup/setupPush.js";
import { jobOf } from "../helpers/machineJobFixture.js";
import { PUSH_TOKEN, pushWorld, type PushWorld } from "../helpers/pushWorld.js";
import { fixtureRepo, git, hostDeps, hostWorkspace, scratchDir } from "../vm/workspace/helpers.js";

/**
 * D#845 ON-8f1: the runner's push of a setup, against REAL git and a real smart-HTTP git server that answers a push only to the one repository's token (test/helpers/pushWorld.ts). The cloud's token route and GitHub's own
 * revoke are stand-ins that record what they were asked. What this cannot show: GitHub's branch protection and push rules, and TLS.
 */
const worlds: PushWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
});

const BRANCH = "fx/engine-install-1.2.3";
const repoOf = (defaultBranch = "main") => ({ id: "77", owner: "acme", name: "Widgets.Service", defaultBranch });

/** A repo whose `main` the remote holds, a host workspace at it, and one install commit on top (what `applyBundle` leaves). */
async function prWorld() {
  const fx = fixtureRepo();
  const w = await pushWorld({ seed: { repo: fx.repo, branch: "main" } });
  worlds.push(w);
  const workspace = hostWorkspace(fx.mirror, fx.commit);
  const commit = (message: string, file = "installed.txt"): string => {
    writeFileSync(path.join(workspace, file), `${message}\n`);
    git(workspace, "add", "-A");
    git(workspace, "commit", "-q", "-m", message);
    return git(workspace, "rev-parse", "HEAD");
  };
  const tip = commit("Install the fulcrumaxe engine 1.2.3");
  const job = jobOf({}, { base_sha: fx.commit, mode: "pr", branch: BRANCH }) as MachineJobOf<"project_setup">;
  const input: SetupPushInput = { job, repo: repoOf(), mirrorDir: fx.mirror, workspace, tip };
  return { fx, w, workspace, commit, tip, job, input };
}

const allFiles = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const info = lstatSync(full);
    if (info.isDirectory()) allFiles(full, out);
    else if (info.isFile()) out.push(full);
  }
  return out;
};

describe("PR mode", () => {
  it("pushes the verified commit to the install branch only, with the token in the one child's environment, and revokes it", async () => {
    const { fx, w, tip, input } = await prWorld();
    const out = await pushSetup(w.deps, input);
    expect(out).toEqual({ ok: true, head: tip });
    expect(w.tip(BRANCH)).toBe(tip);
    expect(w.tip("main")).toBe(fx.commit); // the default branch is untouched
    expect(git(w.remote, "for-each-ref", "--format=%(refname)").split("\n").sort()).toEqual([`refs/heads/${BRANCH}`, "refs/heads/main"]);
    expect(w.asked).toEqual([{ setupId: input.job.setup_id, jobId: input.job.job_id }]);
    expect(w.revoked).toEqual([PUSH_TOKEN]);
    // the push carried the token as the server's basic credential; no request without it was a write
    const pushes = w.server.seen.filter((r) => r.path.includes("git-receive-pack"));
    expect(pushes.length).toBeGreaterThan(0);
    for (const p of pushes) expect(p.authorization).toBe(`Basic ${Buffer.from(`x-access-token:${PUSH_TOKEN}`).toString("base64")}`);
    // a private ref was used and is gone
    expect(git(fx.mirror, "for-each-ref", "refs/fx-push")).toBe("");
  }, 60_000);

  it("never lets the token reach an argument, a file the job wrote, the mirror or the snapshots", async () => {
    const { fx, w, workspace, input } = await prWorld();
    expect((await pushSetup(w.deps, input)).ok).toBe(true);
    const b64 = Buffer.from(`x-access-token:${PUSH_TOKEN}`).toString("base64");
    const text = JSON.stringify(w.argv);
    expect(text).not.toContain(PUSH_TOKEN);
    expect(text).not.toContain(b64);
    for (const root of [fx.mirror, workspace, w.snapshots]) {
      for (const file of allFiles(root)) {
        const bytes = readFileSync(file);
        expect(bytes.includes(PUSH_TOKEN), file).toBe(false);
        expect(bytes.includes(b64), file).toBe(false);
      }
    }
    expect(existsSync(w.snapshots) ? readdirSync(w.snapshots) : []).toEqual([]);
  }, 60_000);

  it("a re-run moves the branch it made before, with a lease on the tip it just read", async () => {
    const first = await prWorld();
    expect((await pushSetup(first.w.deps, first.input)).ok).toBe(true);
    // a second install commit on the same base, as attempt 2 makes: not a descendant of the first
    git(first.workspace, "checkout", "-q", "-B", "second", first.fx.commit);
    const tip2 = first.commit("Install the fulcrumaxe engine 1.2.3 again", "other.txt");
    const out = await pushSetup(first.w.deps, { ...first.input, tip: tip2, job: jobOf({}, { base_sha: first.fx.commit, mode: "pr", branch: BRANCH }) as MachineJobOf<"project_setup"> });
    expect(out).toEqual({ ok: true, head: tip2 });
    expect(first.w.tip(BRANCH)).toBe(tip2);
    expect(first.w.argv.some((a) => a.includes("push") && a.some((x) => x.startsWith("--force-with-lease=refs/heads/fx/engine-install-1.2.3:")))).toBe(true);
  }, 60_000);

  it("does not overwrite a branch a person moved between the read and the push", async () => {
    const r = await prWorld();
    expect((await pushSetup(r.w.deps, r.input)).ok).toBe(true);
    git(r.workspace, "checkout", "-q", "-B", "second", r.fx.commit);
    const tip2 = r.commit("attempt two", "two.txt");
    // someone else pushes to the install branch after it was read and before the push
    let theirs = "";
    r.w.before("push", () => {
      const other = scratchDir("fxw-other-");
      git(other, "clone", "-q", r.w.remote, "c");
      const dir = path.join(other, "c");
      git(dir, "checkout", "-q", "-B", "x", `origin/${BRANCH}`);
      writeFileSync(path.join(dir, "theirs.txt"), "mine\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "a person's commit");
      git(dir, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
      theirs = git(dir, "rev-parse", "HEAD");
    });
    const out = await pushSetup(r.w.deps, { ...r.input, tip: tip2, job: jobOf({}, { base_sha: r.fx.commit, mode: "pr", branch: BRANCH }) as MachineJobOf<"project_setup"> });
    expect(out).toEqual({ ok: false, code: "push_failed", reason: "rejected" });
    expect(r.w.tip(BRANCH)).toBe(theirs);
    expect(r.w.revoked).toHaveLength(2);
  }, 60_000);

  it("refuses the default branch as a target, a commit that is not directly on the base and a tip the workspace does not hold, before it asks for a credential", async () => {
    const r = await prWorld();
    expect(await pushSetup(r.w.deps, { ...r.input, repo: repoOf(BRANCH) })).toEqual({ ok: false, code: "push_failed", reason: "target" });
    git(r.workspace, "checkout", "-q", "-B", "deep", r.fx.commit);
    r.commit("one", "one.txt");
    const deep = r.commit("two", "two.txt");
    expect(await pushSetup(r.w.deps, { ...r.input, tip: deep })).toEqual({ ok: false, code: "push_failed", reason: "not_on_base" });
    expect(await pushSetup(r.w.deps, { ...r.input, tip: "e".repeat(40) })).toEqual({ ok: false, code: "push_failed", reason: "tip_mismatch" });
    expect(await pushSetup(r.w.deps, { ...r.input, tip: "nothex" })).toEqual({ ok: false, code: "push_failed", reason: "target" });
    expect(r.w.asked).toEqual([]);
    expect(r.w.revoked).toEqual([]);
    expect(r.w.tip(BRANCH)).toBeNull();
  }, 60_000);

  it("is push_failed, with nothing pushed and nothing to revoke, when the cloud refuses or cannot be asked", async () => {
    const r = await prWorld();
    const refused = await pushWorld({ seed: { repo: r.fx.repo, branch: "main" }, token: () => undefined });
    worlds.push(refused);
    expect(await pushSetup(refused.deps, r.input)).toEqual({ ok: false, code: "push_failed", reason: "token_refused" });
    expect(refused.tip(BRANCH)).toBeNull();
    expect(refused.revoked).toEqual([]);
    const down = { ...refused.deps, client: { async setupPushToken() { return { kind: "error" as const, status: 0 }; } } };
    expect(await pushSetup(down as never, r.input)).toEqual({ ok: false, code: "push_failed", reason: "token_failed" });
  }, 60_000);

  it("is push_failed and revokes the token when the server will not take it (a token for another repository)", async () => {
    const r = await prWorld();
    const foreign = await pushWorld({ seed: { repo: r.fx.repo, branch: "main" }, token: () => "ghs_not_this_repository" });
    worlds.push(foreign);
    const out = await pushSetup(foreign.deps, r.input);
    expect(out.ok).toBe(false);
    expect(foreign.tip(BRANCH)).toBeNull();
    expect(foreign.revoked).toEqual(["ghs_not_this_repository"]);
  }, 60_000);

  it("refuses an address that is not https (or loopback http for a replaced address) and a login in the address, before a credential is asked for", async () => {
    const r = await prWorld();
    for (const url of ["http://example.com/acme/w.git", "file:///tmp/x", "ext::sh -c id", "https://user:pw@github.com/a/b.git"]) {
      expect(await pushSetup({ ...r.w.deps, remoteUrl: () => url }, r.input)).toMatchObject({ ok: false, code: "push_failed" });
    }
    expect(r.w.asked).toEqual([]);
  }, 60_000);
});

describe("direct mode", () => {
  /** An empty remote, and the host copy the real `createSetupRepos` makes for it: a scratch repository holding the fixed empty base. */
  async function directWorld() {
    const w = await pushWorld();
    worlds.push(w);
    const deps = hostDeps();
    const root = path.join(scratchDir("fxw-direct-"), "ws");
    const repos = createSetupRepos({ git: deps.git, gitLarge: deps.gitLarge, mirrors: { sync: async () => { throw new Error("an empty remote has no mirror"); } }, workspaceRoot: root, scratchDir: () => deps.scratchDir });
    const copy = await repos.open({ repoId: 77, owner: "acme", name: "Widgets.Service", baseSha: EMPTY_BASE_COMMIT, mode: "direct", signal: new AbortController().signal });
    writeFileSync(path.join(copy.workspace, "README.md"), "installed\n");
    git(copy.workspace, "add", "-A");
    git(copy.workspace, "commit", "-q", "-m", "Install the fulcrumaxe engine 1.2.3");
    const tip = git(copy.workspace, "rev-parse", "HEAD");
    const job = jobOf({ issued_at: "2026-11-21T12:00:00.000Z", expires_at: "2026-11-21T12:10:00.000Z" }, { base_sha: EMPTY_BASE_COMMIT, mode: "direct", branch: BRANCH }) as MachineJobOf<"project_setup">;
    const input: SetupPushInput = { job, repo: repoOf(), mirrorDir: copy.mirrorDir, workspace: copy.workspace, tip };
    return { w, copy, tip, input, job };
  }

  it("materialises the fixed empty base commit with real git, and pushes one root commit with the tip's tree to the default branch, never forced", async () => {
    const { w, copy, tip, input } = await directWorld();
    expect(git(copy.workspace, "rev-parse", "HEAD~1")).toBe(EMPTY_BASE_COMMIT);
    const out = await pushSetup(w.deps, input);
    expect(out.ok).toBe(true);
    const head = (out as { head: string }).head;
    expect(w.tip("main")).toBe(head);
    expect(head).not.toBe(tip);
    expect(git(w.remote, "rev-parse", `${head}^{tree}`)).toBe(git(copy.workspace, "rev-parse", `${tip}^{tree}`));
    expect(git(w.remote, "rev-list", "--parents", "-n", "1", head)).toBe(head); // no parent: a root commit
    expect(git(w.remote, "log", "-1", "--format=%an|%cn|%s|%aI", head)).toBe("fulcrumaxe|fulcrumaxe|Install the fulcrumaxe engine 1.2.3|2026-11-21T12:00:00Z");
    // the empty base was never pushed
    expect(() => git(w.remote, "cat-file", "-e", `${EMPTY_BASE_COMMIT}^{commit}`)).toThrow();
    expect(w.argv.filter((a) => a.includes("push")).every((a) => a.every((x) => !x.startsWith("--force") && !x.startsWith("+")))).toBe(true);
    expect(w.revoked).toEqual([PUSH_TOKEN]);
    // the same job makes the same root commit
    expect(git(copy.mirrorDir, "commit-tree", `${tip}^{tree}`, "-m", "Install the fulcrumaxe engine 1.2.3")).not.toBe("");
    await copy.release();
    expect(existsSync(copy.mirrorDir)).toBe(false);
  }, 60_000);

  it("is direct_raced when the branch already has a commit, whether it is seen before the push or the push is rejected, and leaves their commit alone", async () => {
    const early = await directWorld();
    const other = await prWorld();
    git(other.fx.repo, "push", "-q", early.w.remote, "HEAD:refs/heads/main");
    expect(await pushSetup(early.w.deps, early.input)).toEqual({ ok: false, code: "direct_raced", reason: "head_exists" });
    expect(early.w.tip("main")).toBe(other.fx.commit);
    expect(early.w.revoked).toEqual([PUSH_TOKEN]);

    const late = await directWorld();
    late.w.before("push", () => void git(other.fx.repo, "push", "-q", late.w.remote, "HEAD:refs/heads/main"));
    expect(await pushSetup(late.w.deps, late.input)).toEqual({ ok: false, code: "direct_raced", reason: "rejected" });
    expect(late.w.tip("main")).toBe(other.fx.commit);
    expect(late.w.revoked).toEqual([PUSH_TOKEN]);
  }, 60_000);

  it("a transport failure on an empty remote is push_failed, not a race", async () => {
    const r = await directWorld();
    const broken = { ...r.w.deps, remoteUrl: () => `${r.w.server.origin}/acme/nope.git` };
    expect(await pushSetup(broken, r.input)).toMatchObject({ ok: false, code: "push_failed" });
    expect(r.w.revoked).toEqual([PUSH_TOKEN]);
  }, 60_000);
});

describe("the empty base", () => {
  it("is exactly the commit git makes for an empty tree, the fixed identity and the epoch", () => {
    const dir = scratchDir("fxw-empty-");
    execFileSync("git", ["init", "-q", "--bare", "e"], { cwd: dir });
    const made = execFileSync("git", ["-C", path.join(dir, "e"), "commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-m", "Empty base"], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", GIT_AUTHOR_NAME: "fulcrumaxe", GIT_AUTHOR_EMAIL: "runner@localhost", GIT_COMMITTER_NAME: "fulcrumaxe", GIT_COMMITTER_EMAIL: "runner@localhost", GIT_AUTHOR_DATE: "@0 +0000", GIT_COMMITTER_DATE: "@0 +0000", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
    expect(made).toBe(EMPTY_BASE_COMMIT);
  });
});
