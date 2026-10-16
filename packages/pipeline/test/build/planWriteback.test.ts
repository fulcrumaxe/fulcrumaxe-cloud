import { describe, expect, it } from "vitest";
import { parseRoadmapFile } from "@fx/core/src/plan/index.js";
import { buildWritebackText, deriveTaskUpdates, writebackNotice } from "../../src/build/planWriteback.js";
import { PLAN_UPDATE_BRANCH_PREFIX, WritebackGitHubError, createWritebackGitHub, type WritebackHttp } from "../../src/build/planWritebackGitHub.js";
import { APP_EMAIL, FakeGitHub, NAME, OWNER, PERSON_EMAIL } from "./helpers/fakeWritebackGitHub.js";
import { PLAN_PATH, planFile, pull } from "./helpers/planFixture.js";

/** D#598 P5b: the pure content rules, and the GitHub port against a fake that enforces the real API's contract. */

describe("deriveTaskUpdates", () => {
  it("adds a merged pull request to prs and marks a finished task done", () => {
    const u = deriveTaskUpdates(planFile(), [pull(40, "D#9:T1", "merged")]);
    expect(u).toEqual([{ key: "D#9:T1", prs: [40], status: "done" }]);
  });

  it("a partly merged task is in_progress; one with an open pull request is in_review, and open_prs follows GitHub", () => {
    const u = deriveTaskUpdates(planFile(), [pull(21, "D#9:T2", "merged"), pull(30, "D#9:T2", "open")]);
    expect(u).toEqual([{ key: "D#9:T2", openPrs: [30], status: "in_review" }]);
    const after = deriveTaskUpdates(planFile(), [pull(21, "D#9:T2", "merged"), pull(30, "D#9:T2", "merged")]);
    // both merged: done (planned 2)
    expect(after).toEqual([{ key: "D#9:T2", prs: [21, 30], status: "done" }]);
  });

  it("never lowers a status, never removes a recorded pull request, and leaves a status a person set to another word alone", () => {
    // T3 is done with a history pr (5) GitHub does not list; T4 is "deferred" but has a merged pull request
    const u = deriveTaskUpdates(planFile(), [pull(41, "D#9:T4", "merged")]);
    expect(u).toEqual([{ key: "D#9:T4", prs: [41] }]);
    expect(deriveTaskUpdates(planFile(), [])).toEqual([]);
    // an open_prs entry GitHub no longer shows as open is dropped: open_prs is a statement about now
    const stale = planFile({ "D#9:T2": { milestone: "m1", planned_prs: 2, status: "in_progress", prs: [21], open_prs: [30] } });
    expect(deriveTaskUpdates(stale, [])).toEqual([{ key: "D#9:T2", openPrs: [] }]);
  });
});

describe("deriveTaskUpdates never lowers a status (ranked: not_started < in_progress < in_review < done)", () => {
  // three planned pull requests: the write-back sets in_review while one is open, and must not take it back when that one merges
  const three = (status: string, extra: Record<string, unknown> = {}) =>
    planFile({ "D#9:T5": { milestone: "m1", planned_prs: 3, status, prs: [], ...extra } });

  it("in_review whose open pull request has merged (more still to come) keeps in_review and only the lists move", () => {
    const text = three("in_review", { open_prs: [30] });
    const u = deriveTaskUpdates(text, [pull(30, "D#9:T5", "merged")]);
    expect(u).toEqual([{ key: "D#9:T5", prs: [30], openPrs: [] }]);
    expect(u[0]!.status).toBeUndefined();
  });

  it("in_review whose open pull request was closed unmerged keeps in_review", () => {
    const text = three("in_review", { open_prs: [30] });
    const u = deriveTaskUpdates(text, [pull(30, "D#9:T5", "closed")]);
    expect(u).toEqual([{ key: "D#9:T5", openPrs: [] }]);
  });

  it("in_progress with nothing open and nothing new stays in_progress and produces no update", () => {
    const text = three("in_progress", { prs: [21] });
    expect(deriveTaskUpdates(text, [pull(21, "D#9:T5", "merged")])).toEqual([]);
    expect(deriveTaskUpdates(text, [])).toEqual([]);
  });

  it("still moves forward: not_started to in_progress to in_review to done", () => {
    expect(deriveTaskUpdates(three("not_started"), [pull(30, "D#9:T5", "merged")])).toEqual([{ key: "D#9:T5", prs: [30], status: "in_progress" }]);
    expect(deriveTaskUpdates(three("in_progress", { prs: [21] }), [pull(21, "D#9:T5", "merged"), pull(30, "D#9:T5", "open")])).toEqual([
      { key: "D#9:T5", openPrs: [30], status: "in_review" },
    ]);
    expect(
      deriveTaskUpdates(three("in_review", { prs: [1], open_prs: [30] }), [pull(1, "D#9:T5", "merged"), pull(2, "D#9:T5", "merged"), pull(30, "D#9:T5", "merged")]),
    ).toEqual([{ key: "D#9:T5", prs: [1, 2, 30], openPrs: [], status: "done" }]);
  });
});

describe("buildWritebackText", () => {
  it("changes only the requested members and the result still parses", () => {
    const before = planFile();
    const r = buildWritebackText(before, [pull(40, "D#9:T1", "merged")]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changedRows).toBe(1);
    expect(parseRoadmapFile(r.text).tasks.find((t) => t.key === "D#9:T1")).toMatchObject({ filePrs: [40], fileStatus: "done" });
    // every other row is byte-identical
    const rowOf = (t: string, k: string) => JSON.stringify(JSON.parse(t).task_status[k]);
    for (const k of ["D#9:T2", "D#9:T3", "D#9:T4"]) expect(rowOf(r.text, k)).toBe(rowOf(before, k));
    const tail = (t: string) => t.slice(t.indexOf('"D#9:T2": {'));
    expect(tail(r.text)).toBe(tail(before));
  });

  it("with nothing to change, returns the same bytes", () => {
    const text = planFile({ "D#9:T2": { milestone: "m1", planned_prs: 2, status: "in_progress", prs: [21] } });
    const r = buildWritebackText(text, []);
    expect(r).toMatchObject({ ok: true, text, changedRows: 0 });
  });

  it("reports a fixed code for a file that does not parse, and never echoes a task key", () => {
    const secret = "D#9:SECRET-KEY-7";
    const broken = JSON.stringify({ milestones: { m1: { tasks: [secret] } }, task_status: {} });
    const r = buildWritebackText(broken, []);
    expect(r).toEqual({ ok: false, code: "plan_file_invalid" });
    expect(JSON.stringify(r)).not.toContain("SECRET");
    expect(buildWritebackText("{not json", [])).toEqual({ ok: false, code: "plan_file_invalid" });
  });
});

describe("fixed notices", () => {
  it("states the sentences of Correction C3, with the pull request number or the path", () => {
    expect(writebackNotice({ kind: "changed_by_other", prNumber: 7 })).toBe("The plan update PR #7 was changed by someone else. Merge or close it to resume plan updates.");
    expect(writebackNotice({ kind: "plan_file_not_in_overlay", path: PLAN_PATH })).toBe(`Add ${PLAN_PATH} to the overlay paths.`);
    expect(writebackNotice({ kind: "waiting" })).toBe("Plan update waiting");
  });
});

describe("the GitHub port against a contract-enforcing fake", () => {
  const make = () => {
    const gh = new FakeGitHub({ [PLAN_PATH]: planFile() });
    return { gh, api: createWritebackGitHub({ http: gh.http, owner: OWNER, name: NAME }) };
  };

  it("reads a file with its blob sha, and a missing file as null", async () => {
    const { gh, api } = make();
    const f = await api.readFile(PLAN_PATH, gh.tip(), 5_000_000);
    expect(f?.text).toBe(planFile());
    expect(f?.blobSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await api.readFile("nope.json", gh.tip(), 5_000_000)).toBeNull();
  });

  it("a file the contents API will not inline, and one over the bound, are file_too_large", async () => {
    const { gh, api } = make();
    gh.inlineLimit = 10;
    await expect(api.readFile(PLAN_PATH, gh.tip(), 5_000_000)).rejects.toMatchObject({ code: "file_too_large" });
    gh.inlineLimit = 1_000_000;
    await expect(api.readFile(PLAN_PATH, gh.tip(), 10)).rejects.toMatchObject({ code: "file_too_large" });
  });

  it("makes a branch, replaces the file with one commit, opens a pull request, and refuses a stale blob (409)", async () => {
    const { gh, api } = make();
    const base = gh.tip();
    const blob = (await api.readFile(PLAN_PATH, base, 5_000_000))!.blobSha;
    const one = `${PLAN_UPDATE_BRANCH_PREFIX}one`;
    await api.createBranch(one, base);
    await expect(api.createBranch(one, base)).rejects.toMatchObject({ code: "branch_exists" });
    const { commitSha, parentSha } = await api.putFile({ path: PLAN_PATH, branch: one, text: "{}\n", blobSha: blob, message: "m" });
    expect(gh.tip(one)).toBe(commitSha);
    expect(parentSha).toBe(base); // the real API answers the new commit's parents; the caller compares them with the head it expected
    await expect(api.putFile({ path: PLAN_PATH, branch: one, text: "{}\n", blobSha: blob, message: "m" })).rejects.toMatchObject({ code: "conflict" });
    const { number } = await api.openPull({ branch: one, base: "main", title: "t", body: "b" });
    expect(await api.readPull(number)).toMatchObject({ open: true, merged: false, headSha: commitSha, sameRepo: true });
    expect(await api.findPullByBranch(one)).toMatchObject({ number });
    await api.closePull(number);
    expect((await api.readPull(number)).open).toBe(false);
    await api.deleteBranch(one);
    await api.deleteBranch(one); // already gone: fine
    expect(await api.readBranchHead(one)).toBeNull();
  });

  it("refuses a pull request with no commits between the branch and the base (422 -> rejected), as the real pulls API does", async () => {
    const { gh, api } = make();
    const branch = `${PLAN_UPDATE_BRANCH_PREFIX}empty`;
    await api.createBranch(branch, gh.tip());
    await expect(api.openPull({ branch, base: "main", title: "t", body: "b" })).rejects.toMatchObject({ code: "rejected" });
    expect(gh.prs).toHaveLength(0);
  });

  it("compares two commits: the merge base, how far ahead, the files that differ and the messages", async () => {
    const { gh, api } = make();
    const base = gh.tip();
    const branch = `${PLAN_UPDATE_BRANCH_PREFIX}cmp`;
    await api.createBranch(branch, base);
    expect(await api.compare(base, gh.tip(branch))).toEqual({ mergeBaseSha: base, aheadBy: 0, behindBy: 0, files: [], messages: [], identities: [] });
    const blob = (await api.readFile(PLAN_PATH, base, 5_000_000))!.blobSha;
    const { commitSha } = await api.putFile({ path: PLAN_PATH, branch, text: "{}\n", blobSha: blob, message: "the message" });
    gh.pushDefault("README.md", "x\n"); // main moves on
    expect(await api.compare(gh.tip(), commitSha)).toEqual({ mergeBaseSha: base, aheadBy: 1, behindBy: 1, files: [PLAN_PATH], messages: ["the message"], identities: [{ authorEmail: APP_EMAIL, committerEmail: APP_EMAIL }] });
    // a person's commit carries the person's email in both fields
    const theirs = gh.pushAs(branch, "notes.md", "x\n");
    expect((await api.compare(base, theirs)).identities.at(-1)).toEqual({ authorEmail: PERSON_EMAIL, committerEmail: PERSON_EMAIL });
    await expect(api.compare("nothex", commitSha)).rejects.toMatchObject({ code: "bad_input" });
  });

  it("a write that names the default branch, or any branch outside the platform's namespace, sends no request", async () => {
    const { gh, api } = make();
    const blob = (await api.readFile(PLAN_PATH, gh.tip(), 5_000_000))!.blobSha;
    gh.calls.length = 0;
    for (const branch of ["main", "master", "feature/x", "fulcrumaxe/other-thing", "fulcrumaxe/plan-update"]) {
      await expect(api.createBranch(branch, gh.tip())).rejects.toMatchObject({ code: "bad_input" });
      await expect(api.putFile({ path: PLAN_PATH, branch, text: "{}\n", blobSha: blob, message: "m" })).rejects.toMatchObject({ code: "bad_input" });
      await expect(api.deleteBranch(branch)).rejects.toMatchObject({ code: "bad_input" });
      await expect(api.openPull({ branch, base: "main", title: "t", body: "b" })).rejects.toMatchObject({ code: "bad_input" });
    }
    expect(gh.calls).toEqual([]);
    expect(gh.denied).toEqual([]);
    expect(gh.file(PLAN_PATH)).toBe(planFile());
    // reading is not a write: the head of the default branch can still be read
    expect(await api.readBranchHead("main")).toBe(gh.tip());
  });

  it("a configured default branch is refused even when it carries the platform's prefix", async () => {
    const gh = new FakeGitHub({ [PLAN_PATH]: planFile() });
    const name = `${PLAN_UPDATE_BRANCH_PREFIX}default`;
    const api = createWritebackGitHub({ http: gh.http, owner: OWNER, name: NAME, defaultBranch: name });
    await expect(api.createBranch(name, gh.tip())).rejects.toMatchObject({ code: "bad_input" });
    expect(gh.calls).toEqual([]);
  });

  it("maps GitHub's answers to fixed codes: 403 secondary rate limit and 5xx/429 are unavailable, a 403 refusal is rejected, no text is kept", async () => {
    const answer = (status: number, message: string): WritebackHttp => ({ request: async () => ({ status, body: { message } }) });
    const call = (http: WritebackHttp) => createWritebackGitHub({ http, owner: OWNER, name: NAME }).readPull(1).then(() => { throw new Error("expected a failure"); }, (e: unknown) => e as WritebackGitHubError);
    const limited = await call(answer(403, "You have exceeded a secondary rate limit. Please wait a few minutes"));
    expect(limited.code).toBe("unavailable");
    expect(limited.message).not.toContain("secondary");
    expect((await call(answer(403, "Resource not accessible by integration"))).code).toBe("rejected");
    expect((await call(answer(429, "slow down"))).code).toBe("unavailable");
    expect((await call(answer(502, "bad gateway"))).code).toBe("unavailable");
    expect((await call(answer(404, "Not Found"))).code).toBe("rejected");
  });

  it("the fake itself still protects the default branch (a raw write that bypasses the port is a 403)", async () => {
    const { gh } = make();
    const res = await gh.http.request({ method: "PUT", path: `/repos/${OWNER}/${NAME}/contents/${PLAN_PATH}`, body: { branch: "main", content: "", sha: "x", message: "m" } });
    expect(res.status).toBe(403);
    expect(gh.denied).toHaveLength(1);
  });

  it("refuses a malformed path or branch before any request is made", async () => {
    const { gh, api } = make();
    await expect(api.readFile("../etc/passwd", gh.tip(), 10)).rejects.toMatchObject({ code: "bad_input" });
    await expect(api.readBranchHead("a..b")).rejects.toMatchObject({ code: "bad_input" });
    expect(gh.calls).toHaveLength(0);
  });
});
