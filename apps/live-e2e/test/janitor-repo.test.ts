/**
 * The fixture-repo janitor (T6b) against the strict GitHub stand-in in janitor-helpers.ts, served over real TLS
 * (the stand-in refuses a request with no User-Agent or the wrong token). Offline: no real GitHub, no real token.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startStrictGithubServer, type LocalTlsServer } from "../../../packages/github/test/helpers/localTlsServer.js";
import { runRepoJanitor, type RepoJanitorResult } from "../src/janitor/repo.js";
import { BASE_SHA, FakeRepo, GH_REPO, GH_TOKEN, OLD_SHA, RUN_TAG } from "./janitor-helpers.js";

let server: LocalTlsServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function go(fake: FakeRepo, over: { apply?: boolean; target?: string; env?: Record<string, string | undefined>; ca?: boolean } = {}) {
  server = await startStrictGithubServer(fake.route);
  const lines: string[] = [];
  const env = { LIVE_E2E_FIXTURE_REPO: GH_REPO, LIVE_E2E_FIXTURE_REPO_TOKEN: GH_TOKEN, GITHUB_API_URL: `https://127.0.0.1:${server.port}`, ...over.env };
  const result = await runRepoJanitor({ target: over.target ?? "staging", env, apply: over.apply ?? false, say: (l) => lines.push(l), ...(over.ca === false ? {} : { ca: server.ca }) });
  return { result, lines, seen: server.seen };
}
const refusal = (r: RepoJanitorResult) => (r.status === "refused" ? r : expect.fail(`expected a refusal, got ${r.status}`));

/** A repo with something of every kind: human work that must survive, and the janitor's own leftovers. */
function busy(): FakeRepo {
  const f = new FakeRepo();
  f.issue(1, "Login page throws on empty password");
  f.pull(2, "Add retry to the webhook sender", "feature/retry");
  f.issue(3, RUN_TAG);
  f.pull(4, "run g1 fixture change", "fx/run-g1");
  f.branches.set("feature/retry", "1".repeat(40));
  f.branches.set("fx/run-g1", "2".repeat(40));
  f.branches.set(RUN_TAG, "3".repeat(40));
  f.branches.set("fx/pinned", BASE_SHA); // a branch the baseline tag points at
  return f;
}

describe("repo janitor: what it does", () => {
  it("dry run writes nothing", async () => {
    const f = busy();
    const { result, lines } = await go(f);
    expect(f.writes).toEqual([]);
    expect(result.status === "done" && !result.applied).toBe(true);
    expect(lines).toEqual(["would close issue #3", "would close pr #4", 'would delete branch "fx/run-g1"', `would delete branch ${JSON.stringify(RUN_TAG)}`, 'would reset branch "main"']);
  });

  it("never touches what it does not own", async () => {
    const f = busy();
    const { result } = await go(f, { apply: true });
    expect(result.status).toBe("done");
    const open = f.items.filter((i) => i.state === "open").map((i) => i.number);
    expect(open).toEqual([1, 2]); // the human issue and the human PR
    expect([...f.branches.keys()].sort()).toEqual(["feature/retry", "fx/pinned", "main"]);
    expect(f.writes.map((w) => `${w.method} ${w.path.replace(`/repos/${GH_REPO}`, "")}`)).toEqual([
      "PATCH /issues/3",
      "PATCH /pulls/4",
      "DELETE /git/refs/heads/fx/run-g1",
      `DELETE /git/refs/heads/${RUN_TAG}`,
      "PATCH /git/refs/heads/main",
    ]);
  });

  it("moves the default branch to the baseline commit, and a second run finds nothing to do", async () => {
    const f = busy();
    await go(f, { apply: true });
    expect(f.branches.get("main")).toBe(BASE_SHA);
    const again = await go(f, { apply: true });
    expect(again.lines).toEqual(["nothing to do"]);
    expect(f.writes).toHaveLength(5);
  });

  it("follows an annotated baseline tag to its commit", async () => {
    const f = new FakeRepo();
    f.annotated = true;
    await go(f, { apply: true });
    expect(f.branches.get("main")).toBe(BASE_SHA);
  });

  it("owns an fx/ PR only when its head is in the fixture repo, and a title only when the whole title is a run tag", async () => {
    const f = new FakeRepo();
    f.pull(5, "from a fork", "fx/from-fork", "someone-else/fixture");
    f.issue(6, `${RUN_TAG} but a person wrote more`);
    f.issue(7, "e2e-human-notes");
    const { result } = await go(f, { apply: true });
    expect(result.status === "done" && result.actions.map((a) => a.kind)).toEqual(["reset-branch"]);
    expect(f.items.every((i) => i.state === "open")).toBe(true);
  });

  it("pages through more than 100 open items", async () => {
    const f = new FakeRepo();
    for (let n = 1; n <= 101; n += 1) f.issue(n, RUN_TAG);
    await go(f, { apply: true });
    expect(f.items.filter((i) => i.state === "open")).toHaveLength(0);
  });
});

describe("repo janitor: refusals", () => {
  it("a rejected default-branch move is REFUSED janitor-repo-protected naming the branch, and nothing runs after it", async () => {
    const f = busy();
    f.protectedDefault = true;
    const { result } = await go(f, { apply: true });
    const r = refusal(result);
    expect(r.reason).toBe("janitor-repo-protected");
    expect(r.detail).toContain("main");
    expect(r.detail).toContain("branch protection");
    expect(r.done).toBe(4);
    expect(f.writes.at(-1)).toMatchObject({ method: "PATCH", path: `/repos/${GH_REPO}/git/refs/heads/main` });
    expect(f.branches.get("main")).toBe(OLD_SHA);
  });

  it("a missing baseline tag is janitor-repo-no-baseline and writes nothing", async () => {
    const f = busy();
    f.baseline = null;
    const { result } = await go(f, { apply: true });
    expect(refusal(result).reason).toBe("janitor-repo-no-baseline");
    expect(f.writes).toEqual([]);
  });

  it("a baseline that is not a commit sha is janitor-repo-unreadable and writes nothing", async () => {
    const f = busy();
    f.baseline = "not-a-sha";
    expect(refusal((await go(f, { apply: true })).result).reason).toBe("janitor-repo-unreadable");
    expect(f.writes).toEqual([]);
  });

  it("never deletes the default branch, even when its name looks like the janitor's own", async () => {
    const f = new FakeRepo();
    f.defaultBranch = "fx/trunk";
    f.branches = new Map([["fx/trunk", OLD_SHA]]);
    const { result } = await go(f, { apply: true });
    expect(result.status === "done" && result.actions.map((a) => a.kind)).toEqual(["reset-branch"]);
    expect(f.branches.get("fx/trunk")).toBe(BASE_SHA);
  });

  it("a token that cannot read the repo is janitor-repo-unreadable and writes nothing", async () => {
    const f = busy();
    const { result } = await go(f, { apply: true, env: { LIVE_E2E_FIXTURE_REPO_TOKEN: "a-different-token-value" } });
    expect(refusal(result).reason).toBe("janitor-repo-unreadable");
    expect(f.writes).toEqual([]);
  });

  it("a repo the token cannot see is janitor-repo-unreadable too", async () => {
    const f = busy();
    const { result } = await go(f, { env: { LIVE_E2E_FIXTURE_REPO: "test-org/other" } });
    expect(refusal(result).reason).toBe("janitor-repo-unreadable");
  });

  it("a failed write is janitor-repo-write-failed and stops the run", async () => {
    const f = busy();
    f.route = ((inner) => (req) => (req.method === "PATCH" && req.path.endsWith("/pulls/4") ? { status: 500, headers: {}, body: "" } : inner(req)))(f.route);
    const { result } = await go(f, { apply: true });
    expect(refusal(result)).toMatchObject({ reason: "janitor-repo-write-failed", done: 1 });
    expect(f.branches.has("fx/run-g1")).toBe(true);
  });

  it("a repo value that fails the pattern is a usage error naming LIVE_E2E_FIXTURE_REPO, with no request", async () => {
    const { result, seen } = await go(new FakeRepo(), { env: { LIVE_E2E_FIXTURE_REPO: "not a repo" } });
    expect(result).toMatchObject({ status: "usage" });
    expect(result.status === "usage" && result.message).toContain("LIVE_E2E_FIXTURE_REPO");
    expect(seen).toHaveLength(0);
  });

  it.each([{ LIVE_E2E_FIXTURE_REPO: undefined }, { LIVE_E2E_FIXTURE_REPO_TOKEN: "" }])("a missing setting (%o) is SKIPPED-NEED test-repo, with no request", async (env) => {
    const { result, seen } = await go(new FakeRepo(), { env });
    expect(result).toEqual({ status: "skipped", need: "SKIPPED-NEED test-repo" });
    expect(seen).toHaveLength(0);
  });

  it("production is REFUSED janitor-not-staging before any request", async () => {
    const { result, seen } = await go(busy(), { target: "production", apply: true });
    expect(refusal(result).reason).toBe("janitor-not-staging");
    expect(seen).toHaveLength(0);
  });
});

describe("repo janitor: the wire", () => {
  it("sends a User-Agent and the token only in Authorization, over TLS that is really checked, and never prints the token", async () => {
    const { result, lines, seen } = await go(busy(), { apply: true });
    expect(seen.length).toBe(10);
    for (const r of seen) {
      expect(r.headers["user-agent"]).toBeTruthy();
      expect(r.headers["authorization"]).toBe(`Bearer ${GH_TOKEN}`);
      expect(r.path + (r.query ?? "") + r.body).not.toContain(GH_TOKEN);
    }
    expect(JSON.stringify({ result, lines })).not.toContain(GH_TOKEN);
    // Without the stand-in's certificate as a trust root the connection fails: certificate checks are not off.
    const f = busy();
    expect(refusal((await go(f, { ca: false })).result).reason).toBe("janitor-repo-unreadable");
  });
});
