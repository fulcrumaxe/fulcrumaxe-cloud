import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { InstallationTokenCache, type AccessTokenRequester } from "../../github/src/installationToken.js";
import { createInstallationHttp } from "../../github/src/installationHttp.js";
import { strictGithubFetch } from "../../github/test/helpers/strictGithub.js";
import { buildExecutorPrompt } from "../src/advance/build.js";
import { createStackBasePort, decideStackStart, isSafeBranchName, STACK_START_REFUSALS, type StackParentFacts } from "../src/advance/stackBase.js";

/**
 * D#598 P3b (body acceptance 10 and 11, C1 item 1): where a stacked child's run starts. The decision is a pure table; the port is
 * run over the REAL installation client (its path allowlists, its read-only kinds and its one-repository tokens) against a strict
 * GitHub fake, so a read the real client would refuse fails here too.
 */
const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const open = (over: Partial<StackParentFacts> = {}): StackParentFacts => ({ state: "open", merged: false, headSha: HEAD, headRef: "fx/issue-41", headInBaseRepo: true, branchTipSha: HEAD, ...over });

describe("decideStackStart", () => {
  it("an open parent whose pull request head equals the fetched branch tip: start from that branch at that commit", () => {
    expect(decideStackStart(open())).toEqual({ ok: true, base: { branch: "fx/issue-41", sha: HEAD } });
  });

  it("the fetched tip differs from the pull request's head: refused, never built from either", () => {
    expect(decideStackStart(open({ branchTipSha: MOVED }))).toEqual({ ok: false, reason: "stack_parent_head_moved" });
    expect(decideStackStart(open({ headSha: MOVED }))).toEqual({ ok: false, reason: "stack_parent_head_moved" });
  });

  it("the parent already merged: the child builds on the default branch like any item", () => {
    expect(decideStackStart(open({ state: "closed", merged: true }))).toEqual({ ok: true, base: null });
  });

  it("the parent was closed without merging: refused", () => {
    expect(decideStackStart(open({ state: "closed", merged: false }))).toEqual({ ok: false, reason: "stack_parent_closed" });
  });

  it("a parent branch in a fork cannot be fetched from origin: refused", () => {
    expect(decideStackStart(open({ headInBaseRepo: false }))).toEqual({ ok: false, reason: "stack_parent_branch_unusable" });
  });

  it.each(["-delete", "a b", "a;rm -rf /", "a$(x)", "a`x`", "x..y", "a//b", "a/", "x.lock", "x.", "é", "", "a\nb", "a'b", 'a"b', "@{u}"])(
    "a branch name that is not safe to put in a command line (%j) is refused",
    (headRef) => {
      expect(isSafeBranchName(headRef)).toBe(false);
      expect(decideStackStart(open({ headRef }))).toEqual({ ok: false, reason: "stack_parent_branch_unusable" });
    },
  );

  it.each(["fx/issue-41", "feature/a.b-c_d", "release-1.2", "a"])("branch %j is usable", (headRef) => {
    expect(isSafeBranchName(headRef)).toBe(true);
  });

  it.each([
    ["a short head", { headSha: "abc" }],
    ["an upper-case head", { headSha: "A".repeat(40), branchTipSha: "A".repeat(40) }],
    ["no tip", { branchTipSha: "" }],
  ])("%s is unreadable, not equal", (_n, over) => {
    expect(decideStackStart(open(over))).toEqual({ ok: false, reason: "stack_parent_unreadable" });
  });

  it("every refusal is a fixed lower-case code", () => {
    for (const r of STACK_START_REFUSALS) expect(r).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
  });
});

describe("the executor prompt for a stacked child", () => {
  const base = { owner: "acme", name: "widgets", number: 42, branch: "fx/issue-42", version: 1, spec: "Do the thing." };

  it("fetches the parent's branch, checks the commit, branches from it and opens the pull request against it", () => {
    const p = buildExecutorPrompt({ ...base, stackBase: { branch: "fx/issue-41", sha: HEAD } });
    expect(p).toContain(`git fetch origin "+refs/heads/fx/issue-41:refs/remotes/origin/fx/issue-41" && test "$(git rev-parse origin/fx/issue-41)" = "${HEAD}"`);
    expect(p).toContain("BASE=fx/issue-41");
    expect(p).toContain('git checkout -b fx/issue-42 "origin/$BASE"');
    // The pull request's base is the same BASE, so it targets the parent's branch.
    expect(p).toContain(`"base":"'"$BASE"'"`);
    expect(p).not.toContain("BASE=$(git rev-parse --abbrev-ref HEAD)");
  });

  it("a rebuild of a stacked child replaces its earlier branch from the parent's branch, not from the default branch", () => {
    const p = buildExecutorPrompt({ ...base, rebuild: true, stackBase: { branch: "fx/issue-41", sha: HEAD } });
    expect(p).toContain('git checkout -B fx/issue-42 "origin/$BASE"');
    expect(p).not.toContain("Start from the default branch");
  });

  it("an item with no stack parent has the prompt it always had", () => {
    const p = buildExecutorPrompt(base);
    expect(p).toContain("BASE=$(git rev-parse --abbrev-ref HEAD)");
    expect(p).toContain("git checkout -b fx/issue-42");
    expect(p).not.toContain("refs/remotes/origin");
    expect(buildExecutorPrompt({ ...base, stackBase: undefined })).toBe(p);
  });
});

describe("createStackBasePort over the real installation client", () => {
  let privateKeyPem: string;
  beforeAll(() => {
    privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
  });

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const TARGET = { repoId: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets", prNumber: 41 };

  function setup(pull: unknown, ref: { status: number; body: unknown } | "unrequested" = { status: 200, body: { object: { sha: HEAD } } }) {
    const calls: Array<{ method: string; path: string; auth: string | undefined }> = [];
    const minted: Array<Parameters<AccessTokenRequester>[0]> = [];
    const requester: AccessTokenRequester = async (p) => {
      minted.push(p);
      return { token: "ghs_faketoken", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    };
    const fetchImpl = strictGithubFetch((async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ method: init?.method ?? "GET", path: url.pathname, auth: (init?.headers as Record<string, string> | undefined)?.authorization });
      if (url.pathname === "/repos/acme/widgets/pulls/41") return json(200, pull);
      if (url.pathname.startsWith("/repos/acme/widgets/git/ref/heads/") && ref !== "unrequested") return json(ref.status, ref.body);
      return json(404, { message: "Not Found" });
    }) as unknown as typeof fetch);
    const openHttp = createInstallationHttp({
      resolveInstallation: async () => ({ installationId: 9, appKind: "team" }),
      appCredentials: () => ({ appId: "app-1", privateKeyPem, webhookSecret: "unused" }),
      requester,
      cache: new InstallationTokenCache(),
      fetchImpl,
    });
    const port = createStackBasePort({ open: (kind, r) => openHttp(kind, r) });
    return { port, calls, minted };
  }

  const pr = (over: Record<string, unknown> = {}) => ({ number: 41, state: "open", merged: false, head: { sha: HEAD, ref: "fx/issue-41", repo: { full_name: "acme/widgets" } }, base: { ref: "main", repo: { full_name: "acme/widgets", default_branch: "main" } }, ...over });

  it("reads the pull request with the read-only pull request token and the branch tip with the contents-read token, and nothing else", async () => {
    const t = setup(pr());
    const facts = await t.port.readParent(TARGET);
    expect(facts).toEqual({ state: "open", merged: false, headSha: HEAD, headRef: "fx/issue-41", headInBaseRepo: true, branchTipSha: HEAD });
    expect(t.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /repos/acme/widgets/pulls/41", "GET /repos/acme/widgets/git/ref/heads/fx/issue-41"]);
    expect(t.minted.map((m) => m.permissions)).toEqual([{ metadata: "read", pull_requests: "read" }, { metadata: "read", contents: "read" }]);
    expect(t.minted.every((m) => m.repositories?.length === 1 && m.repositories[0] === "widgets")).toBe(true);
  });

  it("a merged parent reads no branch tip at all", async () => {
    const t = setup(pr({ state: "closed", merged: true }), "unrequested");
    const facts = await t.port.readParent(TARGET);
    expect(decideStackStart(facts)).toEqual({ ok: true, base: null });
    expect(t.calls).toHaveLength(1);
  });

  it("a head in a fork: the branch is not read, and the decision is unusable", async () => {
    const t = setup(pr({ head: { sha: HEAD, ref: "fx/issue-41", repo: { full_name: "forker/widgets" } } }), "unrequested");
    const facts = await t.port.readParent(TARGET);
    expect(t.calls).toHaveLength(1);
    expect(decideStackStart(facts)).toEqual({ ok: false, reason: "stack_parent_branch_unusable" });
  });

  it("the branch moved since the pull request was read: head moved", async () => {
    const t = setup(pr(), { status: 200, body: { object: { sha: MOVED } } });
    expect(decideStackStart(await t.port.readParent(TARGET))).toEqual({ ok: false, reason: "stack_parent_head_moved" });
  });

  it("a 200 whose body is not a pull request throws", async () => {
    await expect(setup({ message: "Not Found" }).port.readParent(TARGET)).rejects.toThrow("malformed pull request");
  });

  it("a branch ref that answers 404 throws (the start answers unreadable)", async () => {
    const t = setup(pr(), { status: 404, body: { message: "Not Found" } });
    await expect(t.port.readParent(TARGET)).rejects.toThrow("branch read answered 404");
  });

  it("a branch ref answer without an object sha throws", async () => {
    const t = setup(pr(), { status: 200, body: { object: {} } });
    await expect(t.port.readParent(TARGET)).rejects.toThrow("branch read answered 200");
  });

  it("invalid coordinates are refused before any request", async () => {
    const t = setup(pr());
    await expect(t.port.readParent({ ...TARGET, owner: "../evil" })).rejects.toThrow("invalid repository");
    await expect(t.port.readParent({ ...TARGET, prNumber: 0 })).rejects.toThrow("invalid repository");
    expect(t.calls).toEqual([]);
  });
});
