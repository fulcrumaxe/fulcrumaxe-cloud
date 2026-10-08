import { describe, expect, it } from "vitest";
import { COPY } from "@fulcrumaxe/runner-protocol";
import { LocalOnlyGithubError } from "../src/localOnlyGithub.js";
import { MAX_FILE_PAGES, READY_FALLBACK_LINE, RunPullRequestError, TITLE_MAX, createRunPullRequestPort, pullRequestBody, pullRequestTitle, type PullRequestRepo } from "../src/runPullRequest.js";
import { pathsOutsideScope, parseAcceptanceScope } from "../src/acceptanceScope.js";
import { FakeGithub, StrictFakeError, type FakeChangeType, type FakeRepo } from "./helpers/githubFake.js";

/**
 * D#6 R2b-3e: the `done` pull request port against a strict fake of GitHub that refuses anything outside A1 to A5. The happy path
 * is the draft-first order; each failure class and each guard has its own test.
 */
const REPO: PullRequestRepo = { id: "22222222-2222-4222-8222-222222222222", owner: "acme", name: "widgets" };
const RUN = { runId: "33333333-3333-4333-8333-333333333333", workItemId: "44444444-4444-4444-8444-444444444444", workItemTitle: "Add the footer" };
const BRANCH = `fx/${RUN.runId}-g1`;
const files = (n: number, type: FakeChangeType = "MODIFIED") => Array.from({ length: n }, (_, i) => ({ path: `src/f${i}.ts`, changeType: type }));

function setup(over: { drafts?: boolean; branchFiles?: Array<{ path: string; changeType: FakeChangeType }>; aheadBy?: number; branch?: boolean } = {}) {
  const fake = new FakeGithub();
  const repo: FakeRepo = fake.addRepo("acme", "widgets", { supportsDrafts: over.drafts ?? true });
  if (over.branch !== false) fake.pushBranch(repo, BRANCH, { files: over.branchFiles ?? files(2), aheadBy: over.aheadBy ?? 1 });
  const opened: PullRequestRepo[] = [];
  const port = createRunPullRequestPort({ open: async (r) => (opened.push(r), fake) });
  return { fake, repo, port, opened };
}
const labels = (f: FakeGithub) => f.calls.map((c) => c.label);
const reasonOf = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as RunPullRequestError | null)?.reason;

describe("the draft-first order, end to end", () => {
  it("reads the base, the branch, opens a DRAFT, reads the files, and only then marks it ready: A1 to A5 only, zero refusals", async () => {
    const { fake, repo, port, opened } = setup();
    const base = await port.defaultBranch(REPO);
    expect(base).toBe("main");
    const state = await port.branchState({ repo: REPO, branch: BRANCH, base });
    expect(state).toEqual({ exists: true, headOid: "b".repeat(40), aheadBy: 1, defaultBranch: "main" });
    const pr = await port.openDraft({ repo: REPO, branch: BRANCH, base, run: RUN });
    expect(pr).toMatchObject({ number: 1, draft: true, reused: false });
    expect(repo.pulls[0]!.draft).toBe(true);
    const changed = await port.changedFiles({ repo: REPO, number: pr.number });
    expect(changed).toEqual({ files: files(2), totalCount: 2, complete: true });
    expect(pathsOutsideScope(parseAcceptanceScope(["src/**"]), changed.files.map((f) => f.path))).toEqual([]);
    expect(repo.pulls[0]!.draft).toBe(true); // still a draft until the caller has checked the files
    await port.markReady({ repo: REPO, pullRequest: pr });
    expect(repo.pulls[0]!.draft).toBe(false);

    expect(labels(fake)).toEqual(["A2", "A1 RunBranchState", "A3", "A4", "A1 PullRequestFiles", "A1 MarkReady"]);
    expect(fake.denied).toBe(0);
    expect(opened.every((r) => r === REPO)).toBe(true);
  });

  it("the only pull request it ever creates is a draft, and a ready one is never created: every A4 the fake saw carried draft: true", async () => {
    const { fake, repo, port } = setup();
    await port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN });
    expect(repo.pulls.every((p) => p.draft)).toBe(true);
    expect(fake.denied).toBe(0);
  });

  it("a scope violation closes the pull request (A5) and never marks it ready", async () => {
    const { fake, repo, port } = setup({ branchFiles: [...files(1), { path: ".github/workflows/ci.yml", changeType: "ADDED" }] });
    const pr = await port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN });
    const changed = await port.changedFiles({ repo: REPO, number: pr.number });
    expect(pathsOutsideScope(parseAcceptanceScope(["src/**"]), changed.files.map((f) => f.path))).toEqual([".github/workflows/ci.yml"]);
    await port.close({ repo: REPO, number: pr.number });
    expect(repo.pulls[0]).toMatchObject({ state: "closed", draft: true });
    expect(labels(fake)).not.toContain("A1 MarkReady");
    expect(fake.denied).toBe(0);
  });
});

describe("defaultBranch (A2)", () => {
  it("answers the repository's default branch, whatever it is called", async () => {
    const fake = new FakeGithub();
    fake.addRepo("acme", "widgets", { defaultBranch: "trunk" });
    expect(await createRunPullRequestPort({ open: async () => fake }).defaultBranch(REPO)).toBe("trunk");
  });

  it("a repository GitHub does not know is rejected; an answer about another repository, or without a branch, is malformed", async () => {
    const { fake, port } = setup();
    expect(await reasonOf(port.defaultBranch({ ...REPO, name: "nope" }))).toBe("rejected");
    fake.inject = { label: /^A2$/, reply: { status: 200, body: { full_name: "evil/widgets", default_branch: "main" } } };
    expect(await reasonOf(port.defaultBranch(REPO))).toBe("malformed");
    fake.inject = { label: /^A2$/, reply: { status: 200, body: { full_name: "acme/widgets" } } };
    expect(await reasonOf(port.defaultBranch(REPO))).toBe("malformed");
    fake.inject = { label: /^A2$/, reply: { status: 200, body: null } };
    expect(await reasonOf(port.defaultBranch(REPO))).toBe("malformed");
  });

  it("reads the repository name case-insensitively, as GitHub does", async () => {
    const { port } = setup();
    expect(await port.defaultBranch({ ...REPO, owner: "ACME", name: "Widgets" })).toBe("main");
  });
});

describe("branchState (A1 RunBranchState)", () => {
  it("a missing branch is not an error: it does not exist", async () => {
    const { port } = setup({ branch: false });
    expect(await port.branchState({ repo: REPO, branch: BRANCH, base: "main" })).toEqual({ exists: false, headOid: null, aheadBy: null, defaultBranch: "main" });
  });

  it("a branch with no commit of its own reads aheadBy 0", async () => {
    const { port } = setup({ aheadBy: 0 });
    expect(await port.branchState({ repo: REPO, branch: BRANCH, base: "main" })).toMatchObject({ exists: true, aheadBy: 0 });
  });

  it("a base that is missing leaves aheadBy null (the caller reads null as no commit)", async () => {
    const { port } = setup();
    expect(await port.branchState({ repo: REPO, branch: BRANCH, base: "gone" })).toMatchObject({ exists: true, aheadBy: null });
  });

  it("a null compare, a null aheadBy and an aheadBy that is not a count all pass through as null, never as 0", async () => {
    const { fake, port } = setup();
    const reply = (baseRef: unknown) => ({ status: 200, body: { data: { repository: { defaultBranchRef: { name: "main" }, ref: { name: BRANCH, target: { oid: "b".repeat(40) } }, baseRef } } } });
    for (const baseRef of [null, { compare: null }, { compare: { aheadBy: null } }, { compare: {} }, { compare: { aheadBy: "3" } }, { compare: { aheadBy: -1 } }, { compare: { aheadBy: 1.5 } }]) {
      fake.inject = { label: /RunBranchState/, reply: reply(baseRef) };
      expect(await port.branchState({ repo: REPO, branch: BRANCH, base: "main" }), JSON.stringify(baseRef)).toEqual({ exists: true, headOid: "b".repeat(40), aheadBy: null, defaultBranch: "main" });
    }
    fake.inject = { label: /RunBranchState/, reply: reply({ compare: { aheadBy: 0 } }) };
    expect(await port.branchState({ repo: REPO, branch: BRANCH, base: "main" })).toMatchObject({ aheadBy: 0 });
  });

  it("a repository GitHub cannot resolve is rejected", async () => {
    const { port } = setup();
    expect(await reasonOf(port.branchState({ repo: { ...REPO, name: "nope" }, branch: BRANCH, base: "main" }))).toBe("rejected");
  });

  it("a ref that is not the branch asked for, or has a bad oid, or a body of the wrong shape, is malformed", async () => {
    const { fake, port } = setup();
    const ask = () => port.branchState({ repo: REPO, branch: BRANCH, base: "main" });
    const repository = (ref: unknown) => ({ status: 200, body: { data: { repository: { defaultBranchRef: { name: "main" }, ref, baseRef: null } } } });
    for (const reply of [
      repository({ name: "fx/other", target: { oid: "b".repeat(40) } }),
      repository({ name: BRANCH, target: { oid: "xyz" } }),
      repository({ name: BRANCH, target: {} }),
      repository("ref"),
      { status: 200, body: { data: { repository: "x" } } },
      { status: 200, body: { data: null } },
      { status: 200, body: "<html>" },
      { status: 200, body: null },
    ]) {
      fake.inject = { label: /RunBranchState/, reply };
      expect(await reasonOf(ask()), JSON.stringify(reply)).toBe("malformed");
    }
  });
});

describe("openDraft (A3, A4)", () => {
  it("opens a draft whose title is the work item's and whose body is the fixed template with the two ids", async () => {
    const { repo, port } = setup();
    const pr = await port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN });
    expect(pr).toEqual({ number: 1, nodeId: expect.stringMatching(/^PR_/), draft: true, reused: false });
    expect(repo.pulls[0]).toMatchObject({ title: "Add the footer", head: BRANCH, base: "main", draft: true });
    expect(repo.pulls[0]!.body).toBe(COPY.pullRequestBody.replace("{run}", RUN.runId).replace("{item}", RUN.workItemId));
    expect(repo.pulls[0]!.body).toContain(RUN.runId);
    expect(repo.pulls[0]!.body).toContain(RUN.workItemId);
  });

  it("is idempotent: an open pull request whose head is the branch is reused, and nothing is created", async () => {
    const { fake, repo, port } = setup();
    const first = await port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN });
    const again = await port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN });
    expect(again).toEqual({ ...first, reused: true });
    expect(repo.pulls).toHaveLength(1);
    expect(labels(fake)).toEqual(["A3", "A4", "A3"]);
  });

  it("reuses the oldest of several open pull requests for the branch, and a closed one is not reused", async () => {
    const { fake, repo, port } = setup();
    fake.pushBranch(repo, "release", { files: [] });
    const pr = (n: number, base: string, state: "open" | "closed") => repo.pulls.push({ number: n, nodeId: `PR_kwDOold${n}`, head: BRANCH, base, state, draft: true, title: "t", body: "b" });
    pr(5, "main", "open");
    pr(7, "release", "open");
    pr(3, "main", "closed");
    expect(await port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN })).toMatchObject({ number: 5, reused: true });
  });

  it("reuses a pull request that is already ready, and says so (draft: false), so markReady is not called again", async () => {
    const { fake, repo, port } = setup();
    const first = await port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN });
    await port.markReady({ repo: REPO, pullRequest: first });
    const again = await port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN });
    expect(again).toMatchObject({ number: 1, draft: false, reused: true });
    const before = fake.calls.length;
    await port.markReady({ repo: REPO, pullRequest: again });
    expect(fake.calls.length).toBe(before);
    expect(repo.pulls[0]!.draft).toBe(false);
  });

  it("a pull request from a fork's branch of the same name is not ours and is not reused", async () => {
    const { fake, repo, port } = setup();
    fake.inject = {
      label: /^A3$/,
      reply: { status: 200, body: [{ number: 99, node_id: "PR_fork", state: "open", draft: false, head: { ref: BRANCH, repo: { full_name: "forker/widgets" } }, base: { ref: "main" } }] },
    };
    expect(await port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN })).toMatchObject({ number: 1, reused: false });
    expect(repo.pulls).toHaveLength(1);
  });

  it("when another attempt opens it between our look and our create, GitHub says 422 and the port reuses theirs", async () => {
    const { fake, repo, port } = setup();
    fake.before = (req) => {
      if (req.method === "POST" && repo.pulls.length === 0) repo.pulls.push({ number: 41, nodeId: "PR_kwDOraced", head: BRANCH, base: "main", state: "open", draft: true, title: "t", body: "b" });
    };
    // The first A3 finds nothing; the hook fires on the A4 and the fake then refuses it as a duplicate.
    expect(await port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN })).toMatchObject({ number: 41, reused: true });
    expect(labels(fake)).toEqual(["A3", "A4", "A3"]);
    expect(repo.pulls).toHaveLength(1);
  });

  it("a reused pull request must target the run's base: the look asks for it, and one on another base is not reused even if GitHub returned it", async () => {
    const { fake, repo, port } = setup();
    fake.pushBranch(repo, "release", { files: [] });
    repo.pulls.push({ number: 7, nodeId: "PR_kwDOold7", head: BRANCH, base: "release", state: "open", draft: true, title: "t", body: "b" });
    expect(await port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN })).toMatchObject({ number: 1, reused: false });
    expect(fake.calls[0]!.query).toEqual({ head: `acme:${BRANCH}`, base: "main", state: "open", per_page: 100 });
    // A listing that ignores `base` (or answers wrongly) cannot get a pull request on another base reused.
    for (const base of [{ ref: "release" }, undefined]) {
      const again = setup();
      again.fake.inject = { label: /^A3$/, reply: { status: 200, body: [{ number: 99, node_id: "PR_other", state: "open", draft: false, head: { ref: BRANCH, repo: { full_name: "acme/widgets" } }, base }] } };
      expect(await again.port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN })).toMatchObject({ number: 1, reused: false });
    }
  });

  describe("where the repository cannot have drafts (C23 section 4)", () => {
    const a4 = (f: FakeGithub) => f.calls.filter((c) => c.label === "A4");

    it("retries once with draft: false and the fixed line in the body, and the result is ready, so markReady does nothing", async () => {
      const { fake, repo, port } = setup({ drafts: false });
      const pr = await port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN });
      expect(pr).toEqual({ number: 1, nodeId: expect.stringMatching(/^PR_/), draft: false, reused: false });
      expect(labels(fake)).toEqual(["A3", "A4", "A3", "A4"]);
      expect(repo.pulls).toHaveLength(1);
      expect(repo.pulls[0]).toMatchObject({ draft: false, state: "open" });
      const fixed = COPY.pullRequestBody.replace("{run}", RUN.runId).replace("{item}", RUN.workItemId);
      expect(repo.pulls[0]!.body).toBe(`${fixed}\n\nOpened as ready because this repository does not support draft pull requests.`);
      expect(repo.pulls[0]!.body).toBe(pullRequestBody({ runId: RUN.runId, workItemId: RUN.workItemId }, { readyFallback: true }));
      expect(READY_FALLBACK_LINE).toBe("Opened as ready because this repository does not support draft pull requests.");
      const before = fake.calls.length;
      await port.markReady({ repo: REPO, pullRequest: pr });
      expect(fake.calls.length).toBe(before);
      expect(fake.denied).toBe(0);
    });

    it("sends the draft first (draft: true, the plain body), then exactly one ready retry; a draft body never carries the line", async () => {
      const { fake, port } = setup({ drafts: false });
      const seen: Array<{ draft: unknown; body: string }> = [];
      const real = fake.request.bind(fake);
      fake.request = async (req) => {
        if (req.method === "POST" && req.path.endsWith("/pulls")) seen.push({ draft: (req.body as { draft: unknown }).draft, body: (req.body as { body: string }).body });
        return real(req);
      };
      await port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN });
      expect(seen.map((s) => s.draft)).toEqual([true, false]);
      expect(seen[0]!.body).not.toContain("does not support draft");
      expect(seen[1]!.body).toContain("does not support draft");
      expect(a4(fake)).toHaveLength(2);
    });

    it("a repository that supports drafts never gets a ready pull request: one A4, draft: true", async () => {
      const { fake, repo, port } = setup();
      await port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN });
      expect(a4(fake)).toHaveLength(1);
      expect(repo.pulls[0]!.draft).toBe(true);
      expect(repo.pulls[0]!.body).not.toContain("does not support draft");
    });

    it("answers GitHub's wording in either place: the errors[] message or the top-level message, in any case", async () => {
      for (const reply of [
        { status: 422, body: { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "Draft pull requests are not supported in this repository." }] } },
        { status: 422, body: { message: "DRAFT PULL REQUESTS ARE NOT SUPPORTED in this repository" } },
        { status: 422, body: { message: "Validation Failed", errors: ["draft pull requests are Not Supported"] } },
      ]) {
        const { fake, repo, port } = setup();
        fake.inject = { label: /^A4$/, reply };
        expect(await port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN }), JSON.stringify(reply)).toMatchObject({ number: 1, draft: false });
        expect(repo.pulls).toHaveLength(1);
        expect(a4(fake)).toHaveLength(2);
      }
    });

    it("any other 422 gets no retry and is rejected: no commits, a bad head, and a message with only one of the two words", async () => {
      const other = [
        { status: 422, body: { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "No commits between main and fx/x" }] } },
        { status: 422, body: { message: "Validation Failed", errors: [{ resource: "PullRequest", field: "head", code: "invalid" }] } },
        { status: 422, body: { message: "Draft pull requests are enabled" } },
        { status: 422, body: { message: "Validation Failed", errors: [{ message: "This is not supported" }] } },
        { status: 422, body: null },
        { status: 422, body: "draft not supported" },
      ];
      for (const reply of other) {
        const { fake, repo, port } = setup();
        fake.inject = { label: /^A4$/, reply };
        expect(await reasonOf(port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN })), JSON.stringify(reply)).toBe("rejected");
        expect(a4(fake), JSON.stringify(reply)).toHaveLength(1);
        expect(repo.pulls).toEqual([]);
      }
    });

    it("a draft-unsupported answer on a non-422 status does not trigger the retry", async () => {
      const { fake, port } = setup();
      fake.inject = { label: /^A4$/, reply: { status: 403, body: { message: "Draft pull requests are not supported" } } };
      expect(await reasonOf(port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN }))).toBe("rejected");
      expect(a4(fake)).toHaveLength(1);
    });

    it("a 422 on the retry is rejected, and the port does not try a third time", async () => {
      const { fake, repo, port } = setup({ drafts: false });
      const real = fake.request.bind(fake);
      let posts = 0;
      fake.request = async (req) => {
        if (req.method === "POST" && req.path.endsWith("/pulls") && ++posts === 2) return { status: 422, body: { message: "Validation Failed", errors: [{ message: "No commits between main and x" }] } };
        return real(req);
      };
      expect(await reasonOf(port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN }))).toBe("rejected");
      expect(posts).toBe(2);
      expect(repo.pulls).toEqual([]);
    });

    it("a 422 on the retry that again says drafts are unsupported is still rejected, once", async () => {
      const { fake, port } = setup({ drafts: false });
      const real = fake.request.bind(fake);
      let posts = 0;
      fake.request = async (req) => {
        if (req.method === "POST" && req.path.endsWith("/pulls")) {
          posts++;
          return { status: 422, body: { message: "Validation Failed", errors: [{ message: "Draft pull requests are not supported in this repository." }] } };
        }
        return real(req);
      };
      expect(await reasonOf(port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN }))).toBe("rejected");
      expect(posts).toBe(2);
    });

    it("a 5xx on the retry is unavailable, a malformed answer is malformed, like any create", async () => {
      const { fake, port } = setup({ drafts: false });
      const real = fake.request.bind(fake);
      let reply: { status: number; body: unknown } | null = null;
      let posts = 0;
      fake.request = async (req) => (req.method === "POST" && req.path.endsWith("/pulls") && ++posts % 2 === 0 && reply ? reply : real(req));
      reply = { status: 502, body: null };
      expect(await reasonOf(port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN }))).toBe("unavailable");
      reply = { status: 201, body: { number: 1 } };
      expect(await reasonOf(port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN }))).toBe("malformed");
    });

    it("a scope violation on a ready fallback closes the pull request like any other", async () => {
      const { repo, port } = setup({ drafts: false, branchFiles: [{ path: ".github/workflows/ci.yml", changeType: "ADDED" }] });
      const pr = await port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN });
      await port.close({ repo: REPO, number: pr.number });
      expect(repo.pulls[0]).toMatchObject({ state: "closed", draft: false });
    });
  });

  it("a branch with no commit of its own is rejected by GitHub, and so is a missing branch", async () => {
    expect(await reasonOf(setup({ aheadBy: 0 }).port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN }))).toBe("rejected");
    expect(await reasonOf(setup({ branch: false }).port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN }))).toBe("rejected");
  });

  it("answers about a different head, a missing number or a wrong state are malformed", async () => {
    const { fake, port } = setup();
    const created = (over: object) => ({ status: 201, body: { number: 1, node_id: "PR_x", state: "open", draft: true, head: { ref: BRANCH, repo: { full_name: "acme/widgets" } }, base: { ref: "main" }, ...over } });
    for (const over of [{ head: { ref: "fx/other", repo: { full_name: "acme/widgets" } } }, { number: "1" }, { number: 0 }, { node_id: 5 }, { state: "closed" }, { draft: "yes" }, { head: null }]) {
      fake.inject = { label: /^A4$/, reply: created(over) };
      expect(await reasonOf(port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN })), JSON.stringify(over)).toBe("malformed");
    }
  });

  it("a malformed id is refused before any call, so a body cannot be built from anything but the two ids", async () => {
    const { fake, port } = setup();
    await expect(port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: { ...RUN, runId: "not a uuid {run}" } })).rejects.toThrow(TypeError);
    await expect(port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: { ...RUN, workItemId: "../etc" } })).rejects.toThrow(TypeError);
    expect(fake.calls).toEqual([]);
  });
});

describe("the title and the body", () => {
  it("cut the title to 256 characters without splitting a character, collapse whitespace and control characters, and fall back when nothing is left", () => {
    expect(pullRequestTitle("  Add\tthe\n footer  ")).toBe("Add the footer");
    expect(pullRequestTitle("x".repeat(300))).toBe("x".repeat(TITLE_MAX));
    const emoji = pullRequestTitle("😀".repeat(200));
    expect(emoji.length).toBeLessThanOrEqual(TITLE_MAX);
    expect([...emoji].every((c) => c === "😀")).toBe(true);
    expect(emoji).toBe("😀".repeat(128));
    expect(pullRequestTitle("a".repeat(255) + "😀")).toBe("a".repeat(255));
    for (const empty of [null, "", "   ", "\n\t\u0000"]) expect(pullRequestTitle(empty)).toBe(COPY.pullRequestTitleFallback);
  });

  it("the body is the template with the run and work item ids and nothing else", () => {
    const body = pullRequestBody({ runId: RUN.runId, workItemId: RUN.workItemId });
    expect(body).toBe(COPY.pullRequestBody.replace("{run}", RUN.runId).replace("{item}", RUN.workItemId));
    expect(body).not.toMatch(/\{[a-z]+\}/);
  });

  it("the open call takes the ids and the title, and no body: a field named agentOutput or body on the input is never sent", async () => {
    const { repo, port } = setup();
    const run = { ...RUN, agentOutput: "SECRET OUTPUT", body: "SECRET BODY" } as typeof RUN;
    await port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run });
    expect(repo.pulls[0]!.body).not.toContain("SECRET");
    expect(repo.pulls[0]!.title).not.toContain("SECRET");
  });
});

describe("changedFiles (A1 PullRequestFiles)", () => {
  async function opened(n: number, type?: FakeChangeType) {
    const t = setup({ branchFiles: files(n, type) });
    const pr = await t.port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN });
    return { ...t, pr };
  }

  it("reads every page, 100 to a page, with the total, and says complete", async () => {
    const { fake, port, pr } = await opened(250);
    const changed = await port.changedFiles({ repo: REPO, number: pr.number });
    expect(changed.files).toHaveLength(250);
    expect(changed).toMatchObject({ totalCount: 250, complete: true });
    expect(labels(fake).filter((l) => l === "A1 PullRequestFiles")).toHaveLength(3);
  });

  it("an exact page boundary is complete", async () => {
    const { port, pr } = await opened(100);
    expect(await port.changedFiles({ repo: REPO, number: pr.number })).toMatchObject({ totalCount: 100, complete: true });
  });

  it("no files at all is complete with none", async () => {
    const { port, pr } = await opened(0);
    expect(await port.changedFiles({ repo: REPO, number: pr.number })).toEqual({ files: [], totalCount: 0, complete: true });
  });

  it("reports every change type as given", async () => {
    const types: FakeChangeType[] = ["ADDED", "DELETED", "RENAMED", "COPIED", "MODIFIED", "CHANGED"];
    const t = setup({ branchFiles: types.map((changeType, i) => ({ path: `a/${i}`, changeType })) });
    const pr = await t.port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN });
    expect((await t.port.changedFiles({ repo: REPO, number: pr.number })).files.map((f) => f.changeType)).toEqual(types);
  });

  it("when GitHub says there are more files than were read, the answer is NOT complete", async () => {
    const { fake, port, pr } = await opened(150);
    // The second page arrives short: 120 of the 150 files were read, and the listing ends.
    let page = 0;
    const real = fake.request.bind(fake);
    fake.request = async (req) => {
      const res = await real(req);
      if (req.path === "/graphql" && ++page === 2) {
        const list = (res.body as { data: { repository: { pullRequest: { files: { nodes: unknown[]; pageInfo: { hasNextPage: boolean } } } } } }).data.repository.pullRequest.files;
        list.nodes = list.nodes.slice(0, 20);
        list.pageInfo.hasNextPage = false;
      }
      return res;
    };
    expect(await port.changedFiles({ repo: REPO, number: pr.number })).toMatchObject({ totalCount: 150, complete: false });
  });

  it("more pages than GitHub ever lists for one pull request stops at the cap and is NOT complete", async () => {
    const { fake, port, pr } = await opened((MAX_FILE_PAGES + 1) * 100);
    const changed = await port.changedFiles({ repo: REPO, number: pr.number });
    expect(changed.complete).toBe(false);
    expect(changed.files).toHaveLength(MAX_FILE_PAGES * 100);
    expect(labels(fake).filter((l) => l === "A1 PullRequestFiles")).toHaveLength(MAX_FILE_PAGES);
  });

  it("a pull request GitHub does not know is rejected", async () => {
    const { port } = await opened(1);
    expect(await reasonOf(port.changedFiles({ repo: REPO, number: 999 }))).toBe("rejected");
  });

  it("passes changeType through exactly as GitHub gave it: an unknown value is kept, never classified, and an empty one is malformed", async () => {
    const { fake, port, pr } = await opened(2);
    const page = (nodes: unknown[]) => ({ status: 200, body: { data: { repository: { pullRequest: { files: { totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } } });
    fake.inject = { label: /PullRequestFiles/, reply: page([{ path: "a.ts", changeType: "MOVED" }, { path: "b.ts", changeType: "renamed" }]) };
    expect(await port.changedFiles({ repo: REPO, number: pr.number })).toEqual({ files: [{ path: "a.ts", changeType: "MOVED" }, { path: "b.ts", changeType: "renamed" }], totalCount: 2, complete: true });
    for (const changeType of ["", 5, null, undefined]) {
      fake.inject = { label: /PullRequestFiles/, reply: page([{ path: "a.ts", changeType }]) };
      expect(await reasonOf(port.changedFiles({ repo: REPO, number: pr.number })), String(changeType)).toBe("malformed");
    }
  });

  it("more nodes than totalCount is NOT complete (only exactly totalCount is), whichever way the count is off", async () => {
    const { fake, port, pr } = await opened(2);
    const page = (total: number, n: number) => ({ status: 200, body: { data: { repository: { pullRequest: { files: { totalCount: total, pageInfo: { hasNextPage: false, endCursor: null }, nodes: Array.from({ length: n }, (_, i) => ({ path: `src/f${i}.ts`, changeType: "MODIFIED" })) } } } } } });
    for (const [total, n, complete] of [[2, 3, false], [2, 2, true], [3, 2, false], [0, 1, false]] as const) {
      fake.inject = { label: /PullRequestFiles/, reply: page(total, n) };
      expect(await port.changedFiles({ repo: REPO, number: pr.number }), `${total} ${n}`).toMatchObject({ totalCount: total, complete });
    }
  });

  it("a page of the wrong shape is malformed: an empty path, too many nodes, a cursor that does not move, a missing total", async () => {
    const { fake, port, pr } = await opened(2);
    const page = (list: object) => ({ status: 200, body: { data: { repository: { pullRequest: { files: { totalCount: 2, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [], ...list } } } } } });
    const node = { path: "a.ts", changeType: "MODIFIED" };
    for (const list of [
      { nodes: [{ path: "", changeType: "ADDED" }] },
      { nodes: [{ path: 5, changeType: "ADDED" }] },
      { nodes: [null] },
      { nodes: Array.from({ length: 101 }, () => node) },
      { totalCount: "2" },
      { totalCount: -1 },
      { pageInfo: { hasNextPage: "no" } },
      { pageInfo: { hasNextPage: true, endCursor: null } },
      { nodes: "x" },
    ]) {
      fake.inject = { label: /PullRequestFiles/, reply: page(list) };
      expect(await reasonOf(port.changedFiles({ repo: REPO, number: pr.number })), JSON.stringify(list)).toBe("malformed");
    }
  });

  it("a cursor that does not move is malformed, not an endless loop", async () => {
    const { fake, port, pr } = await opened(2);
    const stuck = { status: 200, body: { data: { repository: { pullRequest: { files: { totalCount: 500, pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [{ path: "a.ts", changeType: "ADDED" }] } } } } } };
    const real = fake.request.bind(fake);
    fake.request = async (req) => (req.path === "/graphql" ? stuck : real(req));
    expect(await reasonOf(port.changedFiles({ repo: REPO, number: pr.number }))).toBe("malformed");
  });
});

describe("markReady and close", () => {
  it("markReady turns a draft ready; a GraphQL error on it (not a draft, unknown id) is rejected, and a wrong answer is malformed", async () => {
    const { fake, repo, port } = setup();
    const pr = await port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN });
    await port.markReady({ repo: REPO, pullRequest: pr });
    expect(repo.pulls[0]!.draft).toBe(false);
    // The caller thinks it is still a draft, GitHub says it is not: an error, never a silent success.
    expect(await reasonOf(port.markReady({ repo: REPO, pullRequest: pr }))).toBe("rejected");
    expect(await reasonOf(port.markReady({ repo: REPO, pullRequest: { ...pr, nodeId: "PR_unknown" } }))).toBe("rejected");
    fake.inject = { label: /MarkReady/, reply: { status: 200, body: { data: { markPullRequestReadyForReview: { pullRequest: { number: 9, isDraft: false } } } } } };
    expect(await reasonOf(port.markReady({ repo: REPO, pullRequest: pr }))).toBe("malformed");
    fake.inject = { label: /MarkReady/, reply: { status: 200, body: { data: { markPullRequestReadyForReview: { pullRequest: { number: 1, isDraft: true } } } } } };
    expect(await reasonOf(port.markReady({ repo: REPO, pullRequest: pr }))).toBe("malformed");
  });

  it("close closes the pull request; an unknown one is rejected; an answer that is not closed is malformed", async () => {
    const { fake, repo, port } = setup();
    const pr = await port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN });
    await port.close({ repo: REPO, number: pr.number });
    expect(repo.pulls[0]!.state).toBe("closed");
    expect(await reasonOf(port.close({ repo: REPO, number: 999 }))).toBe("rejected");
    fake.inject = { label: /^A5$/, reply: { status: 200, body: { number: 1, state: "open" } } };
    expect(await reasonOf(port.close({ repo: REPO, number: pr.number }))).toBe("malformed");
    fake.inject = { label: /^A5$/, reply: { status: 200, body: { number: 2, state: "closed" } } };
    expect(await reasonOf(port.close({ repo: REPO, number: pr.number }))).toBe("malformed");
  });
});

describe("failures from GitHub", () => {
  const calls: Array<[string, (p: ReturnType<typeof setup>["port"]) => Promise<unknown>, RegExp]> = [
    ["defaultBranch", (p) => p.defaultBranch(REPO), /^A2$/],
    ["branchState", (p) => p.branchState({ repo: REPO, branch: BRANCH, base: "main" }), /RunBranchState/],
    ["openDraft (the look)", (p) => p.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN }), /^A3$/],
    ["changedFiles", (p) => p.changedFiles({ repo: REPO, number: 1 }), /PullRequestFiles/],
    ["close", (p) => p.close({ repo: REPO, number: 1 }), /^A5$/],
  ];
  for (const [name, call, label] of calls) {
    it(`${name}: a 5xx, a 429, a rate-limit 403 and a transport error are unavailable and retryable; the error names nothing`, async () => {
      const { fake, port } = setup();
      for (const reply of [
        { status: 500, body: { message: "Server Error" } },
        { status: 502, body: null },
        { status: 503, body: "<html>acme/widgets</html>" },
        { status: 429, body: { message: "slow down" } },
        { status: 403, body: { message: "You have exceeded a secondary rate limit." } },
        new Error("connect ECONNRESET api.github.com for acme/widgets with ghs_secret"),
      ]) {
        fake.inject = { label, reply };
        const error = (await call(port).then(() => null, (e: unknown) => e)) as RunPullRequestError;
        expect(error, name).toBeInstanceOf(RunPullRequestError);
        expect(error.reason).toBe("unavailable");
        expect(error.retryable).toBe(true);
        expect(error.message).toBe("run pull request: unavailable");
      }
    });

    it(`${name}: a 401, a plain 403 and a 404 are rejected, not retryable`, async () => {
      const { fake, port } = setup();
      for (const status of [401, 403, 404, 410]) {
        fake.inject = { label, reply: { status, body: { message: "Resource not accessible by integration" } } };
        const error = (await call(port).then(() => null, (e: unknown) => e)) as RunPullRequestError;
        expect(error.reason, `${name} ${status}`).toBe("rejected");
        expect(error.retryable).toBe(false);
      }
    });
  }

  it("a GraphQL RATE_LIMITED error is unavailable; any other GraphQL error is rejected; none of it is read as data", async () => {
    const { fake, port } = setup();
    const withError = (type: string) => ({ status: 200, body: { data: { repository: { defaultBranchRef: null, ref: null, baseRef: null } }, errors: [{ type, message: "acme/widgets" }] } });
    fake.inject = { label: /RunBranchState/, reply: withError("RATE_LIMITED") };
    expect(await reasonOf(port.branchState({ repo: REPO, branch: BRANCH, base: "main" }))).toBe("unavailable");
    fake.inject = { label: /RunBranchState/, reply: withError("FORBIDDEN") };
    expect(await reasonOf(port.branchState({ repo: REPO, branch: BRANCH, base: "main" }))).toBe("rejected");
  });

  describe("a client that cannot be opened", () => {
    const failing = (make: () => unknown) => createRunPullRequestPort({ open: async () => { throw make(); } });
    const withReason = (reason: string) => Object.assign(new Error(`installationHttp: ${reason} for acme/widgets ghs_secret`), { reason });
    const withCode = (code: string) => Object.assign(new Error(`${code} for acme/widgets`), { code });

    it("no installation, and an App that cannot write (read-only), are rejected and not retryable: a retry cannot fix them", async () => {
      for (const make of [() => withReason("no_installation"), () => withCode("installation_not_writable")]) {
        const error = (await failing(make).defaultBranch(REPO).catch((e: unknown) => e)) as RunPullRequestError;
        expect(error).toBeInstanceOf(RunPullRequestError);
        expect(error.reason).toBe("rejected");
        expect(error.retryable).toBe(false);
        expect(error.message).toBe("run pull request: rejected");
      }
    });

    it("a token mint that failed or timed out, and a transport error, are unavailable and retryable; none of them names anything", async () => {
      for (const make of [() => withReason("mint_failed"), () => Object.assign(new Error("installationToken: mint_timeout acme/widgets"), { name: "MintTimeoutError" }), () => new Error("connect ECONNRESET api.github.com"), () => "a thrown string", () => null]) {
        const error = (await failing(make).defaultBranch(REPO).catch((e: unknown) => e)) as RunPullRequestError;
        expect(error.reason).toBe("unavailable");
        expect(error.retryable).toBe(true);
        expect(error.message).not.toContain("acme");
        expect(error.message).not.toContain("ghs_");
      }
    });

    it("the same split holds for every call that opens a client", async () => {
      const port = failing(() => withReason("no_installation"));
      const calls = [
        () => port.defaultBranch(REPO),
        () => port.branchState({ repo: REPO, branch: BRANCH, base: "main" }),
        () => port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN }),
        () => port.changedFiles({ repo: REPO, number: 1 }),
        () => port.close({ repo: REPO, number: 1 }),
        () => port.markReady({ repo: REPO, pullRequest: { number: 1, nodeId: "PR_x", draft: true, reused: false } }),
      ];
      for (const call of calls) expect(await reasonOf(call())).toBe("rejected");
    });
  });
});

describe("the allowlist is applied by the port itself", () => {
  it("a client handed to `open` is wrapped: a branch name outside the allowlist's shape throws LocalOnlyGithubError, not a GitHub failure, and reaches nothing", async () => {
    const { fake, port } = setup();
    const error = await port.branchState({ repo: REPO, branch: "../../etc", base: "main" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LocalOnlyGithubError);
    expect(error).not.toBeInstanceOf(RunPullRequestError);
    await expect(port.close({ repo: REPO, number: -1 })).rejects.toBeInstanceOf(LocalOnlyGithubError);
    await expect(port.openDraft({ repo: REPO, branch: "a b", base: "main", run: RUN })).rejects.toBeInstanceOf(LocalOnlyGithubError);
    expect(fake.calls).toEqual([]);
  });

  it("every call carries Accept: application/vnd.github+json, and the strict fake refuses one without it", async () => {
    const { fake, port } = setup();
    await port.defaultBranch(REPO); // would throw StrictFakeError inside the fake without the header
    const bare = new FakeGithub();
    bare.addRepo("acme", "widgets");
    await expect(bare.request({ method: "GET", path: "/repos/acme/widgets" })).rejects.toBeInstanceOf(StrictFakeError);
    await expect(bare.request({ method: "GET", path: "/repos/acme/widgets", headers: { accept: "application/vnd.github.diff" } })).rejects.toBeInstanceOf(StrictFakeError);
    expect(fake.denied).toBe(0);
  });

  it("the fake itself refuses what is outside A1 to A5, so a pass here is not the wrapper's doing alone", async () => {
    const fake = new FakeGithub();
    fake.addRepo("acme", "widgets");
    const accept = { accept: "application/vnd.github+json" };
    for (const req of [
      { method: "GET", path: "/repos/acme/widgets/pulls/1/files" },
      { method: "GET", path: "/repos/acme/widgets/commits/main" },
      { method: "GET", path: "/repos/acme/widgets/contents/a.ts" },
      { method: "GET", path: "/repos/acme/widgets/pulls/1" },
      { method: "PUT", path: "/repos/acme/widgets/pulls/1/merge", body: {} },
      { method: "POST", path: "/repos/acme/widgets/pulls", body: { title: "t", head: "h", base: "main", body: "b", draft: "false" } },
      { method: "POST", path: "/repos/acme/widgets/pulls", body: { title: "t", head: "h", base: "main", body: "b" } },
      { method: "PATCH", path: "/repos/acme/widgets/pulls/1", body: { state: "open" } },
      { method: "PATCH", path: "/repos/acme/widgets/pulls/1", body: { state: "closed", title: "x" } },
      { method: "POST", path: "/graphql", body: { query: "{ viewer { login } }", variables: {} } },
      { method: "GET", path: "/repos/acme/widgets/pulls", query: { sort: "created" } },
    ]) {
      await expect(fake.request({ ...req, headers: accept }), `${req.method} ${req.path}`).rejects.toBeInstanceOf(StrictFakeError);
    }
    expect(fake.denied).toBe(11);
    // A boolean draft of either value is inside A4, and the fake answers it.
    await expect(fake.request({ method: "POST", path: "/repos/acme/widgets/pulls", body: { title: "t", head: "h", base: "main", body: "b", draft: false }, headers: accept })).resolves.toMatchObject({ status: 422 });
  });
});
