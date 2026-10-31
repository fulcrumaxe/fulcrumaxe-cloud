import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createInstallationHttp, InstallationTokenCache, type AccessTokenRequester } from "@fx/github";
import { startRevertFake, type RevertFake } from "../../github/test/helpers/revertGithubFake.js";
import { ghError } from "../../github/test/helpers/strictGithub.js";
import { compensate, createGitPort, type GitPortDeps } from "../src/index.js";
import { fakeRebuild } from "./fakes.js";
import { startPullsFake, type FakePr, type PullsFake } from "./helpers/pullsGithubFake.js";

/**
 * D#7 DP7-2d: the real GitPort over the REAL installation clients and token minter, against strict HTTPS fakes of GitHub (real TLS through Node's
 * connection path, a bearer token, a User-Agent, JSON bodies, GraphQL errors arriving as HTTP 200). The close goes through a `runner_pr` client, the
 * one the cloud's pull-request opener wraps in the local-only fence; the revert through a `revert_pr` client.
 * What cannot be faked faithfully: GitHub's revert algorithm (a conflict is declared by the test), a head that moves between the list and the close,
 * rate limits and the wording of errors.
 */
const REPO = { id: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets" };
const RUN = "55555555-5555-4555-8555-555555555555";
const BRANCH = `fx/${RUN}-g1`;
const SHA = "a".repeat(40);
const MOVED = "b".repeat(40);
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";
let privateKeyPem: string;
const servers: Array<PullsFake | RevertFake> = [];
beforeAll(() => {
  privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((f) => f.close()));
});

function opener(fetchImpl: typeof fetch, noInstallation = false) {
  const requester: AccessTokenRequester = async (p) => ({ token: "ghs_faketoken", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: "read", ...(p.permissions as Record<string, string>) }, ...(p.repositories ? { repositories: p.repositories } : {}) });
  return createInstallationHttp({
    resolveInstallation: async () => (noInstallation ? null : { installationId: 9, appKind: "team" }),
    appCredentials: () => ({ appId: "app-1", privateKeyPem, webhookSecret: "unused" }),
    requester,
    cache: new InstallationTokenCache(),
    fetchImpl,
  });
}

async function setup(pulls: FakePr[], o: { managed?: boolean; branch?: string | null; noInstallation?: boolean; merged?: boolean; conflicts?: boolean } = {}) {
  const pf = await startPullsFake("acme", "widgets", pulls);
  const rf = await startRevertFake("acme", "widgets", [{ number: 7, nodeId: "PR_kwDOAAAAAc4AAAAH", merged: o.merged ?? true, ...(o.conflicts ? { conflicts: true } : {}) }]);
  servers.push(pf, rf);
  const openPulls = opener(pf.fetchImpl, o.noInstallation);
  const deps: GitPortDeps = {
    repo: REPO,
    branch: o.branch === undefined ? BRANCH : o.branch,
    openPulls: () => openPulls("runner_pr", { repoId: REPO.id, owner: REPO.owner, name: REPO.name }),
    openRevert: opener(rf.fetchImpl, o.noInstallation),
    personManaged: async () => o.managed === true,
  };
  return { git: createGitPort(deps), pf, rf };
}
const openPr = (over: Partial<FakePr> = {}): FakePr => ({ number: 7, ref: BRANCH, sha: SHA, state: "open", ...over });
const seen = (f: PullsFake | RevertFake) => f.requests.map((r) => `${r.method} ${r.path}`);
const noBranchWrites = (f: PullsFake | RevertFake) => {
  for (const r of f.requests) {
    expect(r.method).not.toBe("DELETE");
    expect(r.path).not.toMatch(/\/git\/refs|\/branches\//);
  }
};

describe("createGitPort: rerunAfterBuild closes at exactly the recorded head", () => {
  it("lists the head branch, closes the pull request once, and deletes no branch and writes no ref", async () => {
    const { git, pf } = await setup([openPr()]);
    expect(await git.rerunAfterBuild({ repo: "acme/widgets", number: 7, headSha: SHA })).toEqual({ ok: true, closed: true });
    expect(seen(pf)).toEqual(["GET /repos/acme/widgets/pulls", "PATCH /repos/acme/widgets/pulls/7"]);
    expect(new URLSearchParams(pf.requests[0]!.query).get("head")).toBe(`acme:${BRANCH}`);
    expect(JSON.parse(pf.requests[1]!.body)).toEqual({ state: "closed" });
    expect(pf.requests.every((r) => /^Bearer \S+$/.test(r.headers["authorization"] ?? "") && (r.headers["user-agent"] ?? "") !== "")).toBe(true);
    expect(pf.pulls[0]!.state).toBe("closed");
    noBranchWrites(pf);
  });

  it("SANDBOX-RERUN-BRANCH-b: an item with two sandbox runs closes by the branch its run recorded: run 2 by its run branch, run 1 by the fixed name, and never one for the other", async () => {
    const FIXED = "fx/issue-41";
    const world = () => [openPr({ number: 6, ref: FIXED }), openPr({ number: 7, ref: BRANCH, sha: MOVED })];
    // Run 2's pull request is closed through run 2's branch, at run 2's head; run 1's open pull request on the fixed name is not touched.
    const two = await setup(world(), { branch: BRANCH });
    expect(await two.git.rerunAfterBuild({ repo: "acme/widgets", number: 7, headSha: MOVED })).toEqual({ ok: true, closed: true });
    expect(two.pf.pulls.map((p) => `${p.number}:${p.state}`)).toEqual(["6:open", "7:closed"]);
    expect(new URLSearchParams(two.pf.requests[0]!.query).get("head")).toBe(`acme:${BRANCH}`);
    noBranchWrites(two.pf);
    // The fixed name does not find run 2's pull request (it is another head), so a lookup by the item's fixed name leaves it open.
    const fixedForTwo = await setup(world(), { branch: FIXED });
    expect(await fixedForTwo.git.rerunAfterBuild({ repo: "acme/widgets", number: 7, headSha: MOVED })).toEqual({ ok: false, code: "not_open" });
    expect(fixedForTwo.pf.pulls.map((p) => p.state)).toEqual(["open", "open"]);
    // A first-run pull request is closed by the fixed name; a head that moved on run 2's branch is left.
    const one = await setup(world(), { branch: FIXED });
    expect(await one.git.rerunAfterBuild({ repo: "acme/widgets", number: 6, headSha: SHA })).toEqual({ ok: true, closed: true });
    const moved = await setup(world(), { branch: BRANCH });
    expect(await moved.git.rerunAfterBuild({ repo: "acme/widgets", number: 7, headSha: SHA })).toEqual({ ok: false, code: "stale_head" });
    expect(moved.pf.pulls.map((p) => p.state)).toEqual(["open", "open"]);
  });

  it("a head that moved is stale_head and nothing is closed", async () => {
    const { git, pf } = await setup([openPr({ sha: MOVED })]);
    expect(await git.rerunAfterBuild({ repo: "acme/widgets", number: 7, headSha: SHA })).toEqual({ ok: false, code: "stale_head" });
    expect(seen(pf)).toEqual(["GET /repos/acme/widgets/pulls"]);
    expect(pf.pulls[0]!.state).toBe("open");
  });

  it("a person's takeover is person_managed and GitHub is not asked at all", async () => {
    const { git, pf } = await setup([openPr()], { managed: true });
    expect(await git.rerunAfterBuild({ repo: "acme/widgets", number: 7, headSha: SHA })).toEqual({ ok: false, code: "person_managed" });
    expect(pf.requests).toEqual([]);
  });

  it("a closed pull request, or none on that branch with that number, is not_open; nothing is closed", async () => {
    expect(await (await setup([openPr({ state: "closed" })])).git.rerunAfterBuild({ repo: "acme/widgets", number: 7, headSha: SHA })).toEqual({ ok: false, code: "not_open" });
    const other = await setup([openPr({ number: 8 })]);
    expect(await other.git.rerunAfterBuild({ repo: "acme/widgets", number: 7, headSha: SHA })).toEqual({ ok: false, code: "not_open" });
    expect(seen(other.pf)).toEqual(["GET /repos/acme/widgets/pulls"]);
  });

  it("a pull request whose head is a fork's branch of the same name is not ours and is not closed", async () => {
    const { git, pf } = await setup([openPr({ headRepo: "mallory/widgets" })]);
    expect(await git.rerunAfterBuild({ repo: "acme/widgets", number: 7, headSha: SHA })).toEqual({ ok: false, code: "not_open" });
    expect(pf.pulls[0]!.state).toBe("open");
  });

  it("no recorded branch, no installation, and an upstream failure are unavailable with no GitHub text", async () => {
    const noBranch = await setup([openPr()], { branch: null });
    expect(await noBranch.git.rerunAfterBuild({ repo: "acme/widgets", number: 7, headSha: SHA })).toEqual({ ok: false, code: "unavailable" });
    expect(noBranch.pf.requests).toEqual([]);
    const badBranch = await setup([openPr()], { branch: "main" });
    expect(await badBranch.git.rerunAfterBuild({ repo: "acme/widgets", number: 7, headSha: SHA })).toEqual({ ok: false, code: "unavailable" });
    const gone = await setup([openPr()], { noInstallation: true });
    expect(await gone.git.rerunAfterBuild({ repo: "acme/widgets", number: 7, headSha: SHA })).toEqual({ ok: false, code: "unavailable" });
    expect(gone.pf.requests).toEqual([]);
    const down = await setup([openPr()]);
    down.pf.override.reply = ghError(502, "Bad Gateway private text");
    const r = await down.git.rerunAfterBuild({ repo: "acme/widgets", number: 7, headSha: SHA });
    expect(r).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify(r)).not.toMatch(/private text/);
  });

  it("a close GitHub does not confirm (refused, or answered with another pull request) is unavailable", async () => {
    const refused = await setup([openPr()]);
    refused.pf.override.patch = ghError(422, "Validation Failed private text");
    const r = await refused.git.rerunAfterBuild({ repo: "acme/widgets", number: 7, headSha: SHA });
    expect(r).toEqual({ ok: false, code: "unavailable" });
    expect(JSON.stringify(r)).not.toMatch(/private text/);
    const wrong = await setup([openPr()]);
    wrong.pf.override.patch = { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ number: 8, state: "closed" }) };
    expect(await wrong.git.rerunAfterBuild({ repo: "acme/widgets", number: 7, headSha: SHA })).toEqual({ ok: false, code: "unavailable" });
  });

  it("a listing GitHub cannot be trusted (not an array, an entry with no head) is unavailable, and nothing is closed", async () => {
    const notList = await setup([openPr()]);
    notList.pf.override.reply = { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [] }) };
    expect(await notList.git.rerunAfterBuild({ repo: "acme/widgets", number: 7, headSha: SHA })).toEqual({ ok: false, code: "unavailable" });
    const noHead = await setup([openPr()]);
    noHead.pf.override.reply = { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify([{ number: 7, state: "open" }]) };
    expect(await noHead.git.rerunAfterBuild({ repo: "acme/widgets", number: 7, headSha: SHA })).toEqual({ ok: false, code: "unavailable" });
    expect(seen(noHead.pf)).toEqual(["GET /repos/acme/widgets/pulls"]);
  });

  it("rejects a pull request of another repository, a bad number and a bad sha before any call", async () => {
    const { git, pf } = await setup([openPr()]);
    await expect(git.rerunAfterBuild({ repo: "acme/other", number: 7, headSha: SHA })).rejects.toThrow(TypeError);
    await expect(git.rerunAfterBuild({ repo: "acme/widgets", number: 0, headSha: SHA })).rejects.toThrow(TypeError);
    await expect(git.rerunAfterBuild({ repo: "acme/widgets", number: 7, headSha: "abc" })).rejects.toThrow(TypeError);
    expect(pf.requests).toEqual([]);
  });
});

describe("createGitPort: openRevertPr is DP7-2w's revert", () => {
  it("opens one draft revert of the merged pull request and returns its number", async () => {
    const { git, rf, pf } = await setup([]);
    expect(await git.openRevertPr({ repo: "acme/widgets", number: 7 })).toEqual({ ok: true, number: 901 });
    expect(seen(rf)).toEqual(["GET /repos/acme/widgets/pulls/7", "POST /graphql"]);
    expect(rf.mutations).toHaveLength(1);
    expect(pf.requests).toEqual([]);
    noBranchWrites(rf);
  });

  it("relays not_merged and revert_refused, and maps the rest to unavailable", async () => {
    expect(await (await setup([], { merged: false })).git.openRevertPr({ repo: "acme/widgets", number: 7 })).toEqual({ ok: false, code: "not_merged" });
    expect(await (await setup([], { conflicts: true })).git.openRevertPr({ repo: "acme/widgets", number: 7 })).toEqual({ ok: false, code: "revert_refused" });
    expect(await (await setup([])).git.openRevertPr({ repo: "acme/widgets", number: 99 })).toEqual({ ok: false, code: "unavailable" });
    expect(await (await setup([], { noInstallation: true })).git.openRevertPr({ repo: "acme/widgets", number: 7 })).toEqual({ ok: false, code: "unavailable" });
  });
});

describe("compensate over the real GitPort", () => {
  it("after the build: the pull request is closed on GitHub, Build again is filed, and the branch is untouched", async () => {
    const { git, pf } = await setup([openPr()]);
    const rebuild = fakeRebuild({ roles: { [`${ACCOUNT}:${OWNER}`]: "admin" }, stage: "pr_opened" });
    const out = await compensate({ kind: "rerun", pr: { number: 7, headSha: SHA } }, { accountId: ACCOUNT, workItemId: ITEM, repo: "acme/widgets", side: "runner", actor: OWNER }, { git, rebuild });
    expect(out).toMatchObject({ kind: "rerun", state: "done", prNumber: 7 });
    expect(rebuild.filed).toHaveLength(1);
    expect(seen(pf)).toEqual(["GET /repos/acme/widgets/pulls", "PATCH /repos/acme/widgets/pulls/7"]);
    noBranchWrites(pf);
  });

  it("a head that moved on GitHub ends head_moved, and the pull request stays open", async () => {
    const { git, pf } = await setup([openPr({ sha: MOVED })]);
    const rebuild = fakeRebuild({ roles: { [`${ACCOUNT}:${OWNER}`]: "owner" }, stage: "pr_opened" });
    const out = await compensate({ kind: "rerun", pr: { number: 7, headSha: SHA } }, { accountId: ACCOUNT, workItemId: ITEM, repo: "acme/widgets", side: "runner", actor: OWNER }, { git, rebuild });
    expect(out).toMatchObject({ state: "failed", reasonCode: "head_moved" });
    expect(pf.pulls[0]!.state).toBe("open");
    expect(rebuild.filed).toEqual([]);
  });
});
