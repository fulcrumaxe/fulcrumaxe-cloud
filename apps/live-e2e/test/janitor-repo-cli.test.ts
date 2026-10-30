/**
 * The fixture-repo janitor through the command line: `janitor repo` (exit codes, REFUSED lines), `plan` listing it, and
 * `run` calling it before a destructive pack that needs `test-repo`. The GitHub side is the strict stand-in served over
 * real TLS (janitor-helpers.ts); the app side answers only layer 2. Offline: no real GitHub, no real token.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startStrictGithubServer, type LocalTlsServer } from "../../../packages/github/test/helpers/localTlsServer.js";
import { main, type Io } from "../src/cli.js";
import type { Plan } from "../src/plan.js";
import type { Invocation } from "../src/run.js";
import { putRole, storePath } from "../src/store.js";
import { BYPASS_VALUE, signSession } from "./session-helpers.js";
import { makeIo, makePack, scratchRoot, tmpDir } from "./helpers.js";
import { BASE_SHA, FakeProduct, FakeRepo, GH_REPO, GH_TOKEN, OTHER_ORG_REPO_ID, RUN_TAG, nonGets, repo } from "./janitor-helpers.js";

let server: LocalTlsServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});
const NOW = Date.parse("2026-10-20T12:00:00Z");
const keyBytes = randomBytes(32);
const PACKS = [makePack({ id: "reads", needs: ["bypass"] }), makePack({ id: "wipes", needs: ["bypass", "test-repo"], destructive: true, tier: "standard" })];

async function rig(f: FakeRepo, env: Record<string, string | undefined> = {}, packs = PACKS) {
  server = await startStrictGithubServer(f.route);
  const root = scratchRoot(packs);
  // A destructive pack also brings the account janitor (T6a), which needs the stored owner session.
  const home = tmpDir();
  await putRole(storePath(home, "staging"), "staging", keyBytes, "owner", signSession({ sid: "s1", sessionStart: NOW - 86_400_000, lastSeenAt: NOW - 3_600_000 }));
  const { io, out, err } = makeIo(root, { HOME: home, LIVE_E2E_SESSION_KEY: keyBytes.toString("base64"), VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS_VALUE, LIVE_E2E_FIXTURE_REPO: GH_REPO, LIVE_E2E_FIXTURE_REPO_TOKEN: GH_TOKEN, GITHUB_API_URL: `https://127.0.0.1:${server.port}`, ...env });
  const app = new FakeProduct("https://staging.example.test", () => NOW);
  const started: Invocation[] = [];
  const full: Io = { ...io, fetch: app.fetch, now: () => NOW, githubCa: server.ca, cli: "/pw/cli.js", exec: async (inv) => (started.push(inv), { code: 0, output: "" }) };
  const plan = (): Plan => JSON.parse(readFileSync(join(root, "plan.json"), "utf8")) as Plan;
  return { io: full, out, err, started, plan, seen: server.seen, app };
}
const busy = (): FakeRepo => {
  const f = new FakeRepo();
  f.issue(1, "Login page throws on empty password");
  f.issue(3, RUN_TAG);
  f.pull(4, "run g1 fixture change", "fx/run-g1");
  f.branches.set("fx/run-g1", "2".repeat(40));
  return f;
};

describe("janitor repo", () => {
  it("is a dry-run without --apply: exit 0, each action printed, no write", async () => {
    const f = busy();
    const r = await rig(f);
    expect(await main(["janitor", "repo", "--target", "staging"], r.io)).toBe(0);
    expect(r.out).toEqual(["would close issue #3", "would close pr #4", 'would delete branch "fx/run-g1"', 'would reset branch "main"']);
    expect(f.writes).toEqual([]);
  });

  it("--apply writes and exits 0", async () => {
    const f = busy();
    const r = await rig(f);
    expect(await main(["janitor", "repo", "--target", "staging", "--apply"], r.io)).toBe(0);
    expect(f.branches.get("main")).toBe(BASE_SHA);
    expect(r.out.at(0)).toBe("done: close issue #3");
    expect(f.writes).toHaveLength(4);
  });

  it("a refused default-branch move prints REFUSED with its detail on stderr and exits 1", async () => {
    const f = busy();
    f.protectedDefault = true;
    const r = await rig(f);
    expect(await main(["janitor", "repo", "--target", "staging", "--apply"], r.io)).toBe(1);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toMatch(/^REFUSED janitor-repo-protected \(branch main refused the move to e2e-baseline \(GitHub answered 422\); check its branch protection/);
  });

  it("a missing baseline tag exits 1 with its reason and writes nothing", async () => {
    const f = busy();
    f.baseline = null;
    const r = await rig(f);
    expect(await main(["janitor", "repo", "--target", "staging", "--apply"], r.io)).toBe(1);
    expect(r.err).toEqual(["REFUSED janitor-repo-no-baseline"]);
    expect(f.writes).toEqual([]);
  });

  it("a token GitHub rejects exits 1 as unreadable and writes nothing", async () => {
    const f = busy();
    const r = await rig(f, { LIVE_E2E_FIXTURE_REPO_TOKEN: "ghp_not_the_token_0123456789" });
    expect(await main(["janitor", "repo", "--target", "staging", "--apply"], r.io)).toBe(1);
    expect(r.err).toEqual(["REFUSED janitor-repo-unreadable"]);
    expect(f.writes).toEqual([]);
  });

  it("an unset fixture variable is SKIPPED-NEED test-repo, exit 0, no request", async () => {
    const r = await rig(busy(), { LIVE_E2E_FIXTURE_REPO: undefined });
    expect(await main(["janitor", "repo", "--target", "staging", "--apply"], r.io)).toBe(0);
    expect(r.out).toEqual(["SKIPPED-NEED test-repo"]);
    expect(r.seen).toEqual([]);
  });

  it("a malformed fixture variable exits 2 naming it, with no request", async () => {
    const r = await rig(busy(), { LIVE_E2E_FIXTURE_REPO: "not a repo" });
    expect(await main(["janitor", "repo", "--target", "staging"], r.io)).toBe(2);
    expect(r.err[0]).toContain("LIVE_E2E_FIXTURE_REPO");
    expect(r.seen).toEqual([]);
  });

  it("--target production exits 1 REFUSED janitor-not-staging before any request", async () => {
    const r = await rig(busy());
    expect(await main(["janitor", "repo", "--target", "production", "--apply"], r.io)).toBe(1);
    expect(r.err).toEqual(["REFUSED janitor-not-staging"]);
    expect(r.seen).toEqual([]);
  });

  it("usage errors exit 2 and send nothing", async () => {
    for (const argv of [["janitor", "repo"], ["janitor", "repo", "--target"], ["janitor", "repo", "--target", "staging", "--apply", "--apply"], ["janitor", "repo", "--target", "staging", "--force"], ["janitor", "repo", "--target", "nowhere"], ["janitor", "pool", "--target", "staging"]]) {
      const r = await rig(busy());
      expect(await main(argv, r.io), argv.join(" ")).toBe(2);
      expect(r.seen).toEqual([]);
    }
  });

  it("never prints the token, in a result or a refusal", async () => {
    const f = busy();
    f.protectedDefault = true;
    const r = await rig(f);
    await main(["janitor", "repo", "--target", "staging", "--apply"], r.io);
    expect([...r.out, ...r.err].join("\n")).not.toContain(GH_TOKEN);
  });
});

describe("plan and run", () => {
  it("plan says the repo janitor waits on test-repo (plan is offline) and makes no request", async () => {
    const r = await rig(busy());
    expect(await main(["plan", "--target", "staging", "--tier", "standard"], r.io)).toBe(0);
    expect(r.out).toContain("janitor repo: runs before wipes once their needs are met");
    expect(r.plan().janitors.repo).toEqual({ needed: false, packs: [], pending: ["wipes"] });
    expect(r.seen).toEqual([]);
  });

  it("plan says not needed when no destructive pack needs test-repo (a read-only pack that needs it does not count)", async () => {
    const r = await rig(busy(), {}, [makePack({ id: "wipes", needs: ["bypass"], destructive: true, tier: "standard" }), makePack({ id: "reads-repo", needs: ["bypass", "test-repo"], tier: "standard" })]);
    expect(await main(["plan", "--target", "staging", "--tier", "standard"], r.io)).toBe(0);
    expect(r.out).toContain("janitor repo: not needed");
    expect(r.plan().janitors.repo).toEqual({ needed: false, packs: [], pending: [] });
  });

  it("run resets the repo first (apply), then starts the pack, and the plan names the pack", async () => {
    const f = busy();
    const r = await rig(f);
    expect(await main(["run", "--target", "staging", "--tier", "standard"], r.io)).toBe(0);
    expect(r.out).toContain("janitor repo: runs before wipes");
    expect(f.branches.get("main")).toBe(BASE_SHA);
    expect(r.started.map((i) => i.packId)).toEqual(["reads", "wipes"]);
    expect(r.plan().janitors.repo).toEqual({ needed: true, packs: ["wipes"], pending: [] });
  });

  it("run stops with exit 1 before any pack when the repo janitor is refused", async () => {
    const f = busy();
    f.protectedDefault = true;
    const r = await rig(f);
    expect(await main(["run", "--target", "staging", "--tier", "standard"], r.io)).toBe(1);
    expect(r.err.at(-1)).toMatch(/^REFUSED janitor-repo-protected/);
    expect(r.started).toEqual([]);
  });

  it("run with the account janitor refused never touches GitHub: its REFUSED line is the one printed, zero requests reach the fixture repo", async () => {
    const f = busy();
    const r = await rig(f);
    r.app.state.repos.push(repo(OTHER_ORG_REPO_ID, "personal-login/cloud", 2));
    expect(await main(["run", "--target", "staging", "--tier", "standard"], r.io)).toBe(1);
    expect(r.err.at(-1)).toMatch(/^REFUSED janitor-account-in-use/);
    expect(r.err.join("\n")).not.toContain("janitor-repo");
    // The plan's own test-repo need check reads the baseline tag once; the repo janitor would add its issue, pull and branch reads and then its writes.
    expect(r.seen.map((q) => `${q.method} ${q.path}`)).toEqual(["GET /repos/test-org/fixture/git/ref/tags/e2e-baseline"]);
    expect(f.writes).toEqual([]);
    expect(nonGets(r.app)).toEqual([]);
    expect(r.started).toEqual([]);
  });

  it("run with no destructive pack needing test-repo never calls the repo janitor", async () => {
    const f = busy();
    const r = await rig(f);
    expect(await main(["run", "--target", "staging", "--tier", "smoke"], r.io)).toBe(0);
    expect(r.started.map((i) => i.packId)).toEqual(["reads"]);
    expect(f.writes).toEqual([]);
  });
});
