import { describe, expect, it } from "vitest";
import { RunPullRequestError, createRunPullRequestPort, type PullRequestRepo } from "../src/runPullRequest.js";
import { TWIN_SYNC_LABEL } from "../src/localOnlyGithub.js";
import { FAKE_APP_LOGIN, FakeGithub, installationKindClient, openInstallationKinds } from "./helpers/githubFake.js";

/** D#845 ON-27d3 (A26, A31): the twin sync pull request's label, over the strict fake and the live `setup_labels` path list. */
const REPO: PullRequestRepo = { id: "22222222-2222-4222-8222-222222222222", owner: "acme", name: "widgets-private" };
const BRANCH = "fx/twin-sync-bbbbbbbbbbbb";
const reasonOf = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as RunPullRequestError | null)?.reason;
function setup() {
  const fake = new FakeGithub();
  const repo = fake.addRepo("acme", "widgets-private");
  fake.pushBranch(repo, BRANCH, { files: [{ path: "a.md", changeType: "MODIFIED" }] });
  const asked: Array<string | undefined> = [];
  const open = openInstallationKinds(fake);
  const port = createRunPullRequestPort({ open: async (r, purpose) => (asked.push(purpose), open(r, purpose)), appLogin: async () => FAKE_APP_LOGIN, sleep: async () => undefined });
  return { fake, repo, port, asked };
}

describe("labelTwinSync", () => {
  it("makes the label and puts it on the pull request through the setup_labels client alone; a second call finds the label made and puts it on again", async () => {
    const { fake, repo, port, asked } = setup();
    const ref = await port.openDraft({ repo: REPO, branch: BRANCH, base: "main", text: { title: "t", body: "b" } });
    await port.labelTwinSync({ repo: REPO, number: ref.number });
    expect(asked.slice(1)).toEqual(["setup_labels"]);
    expect(repo.labels.get(TWIN_SYNC_LABEL.name)).toEqual({ name: TWIN_SYNC_LABEL.name, color: TWIN_SYNC_LABEL.color, description: TWIN_SYNC_LABEL.description });
    expect(repo.pulls[0]!.labels).toEqual([TWIN_SYNC_LABEL.name]);
    await port.labelTwinSync({ repo: REPO, number: ref.number });
    expect(repo.pulls[0]!.labels).toEqual([TWIN_SYNC_LABEL.name]);
    expect(repo.labels.size).toBe(1);
    expect(fake.denied).toBe(0);
  });

  it("refuses a number that is not a pull request number before any call, and answers rejected for a pull request GitHub does not have", async () => {
    const { fake, port } = setup();
    for (const number of [0, -1, 1.5, Number.NaN]) expect(await reasonOf(port.labelTwinSync({ repo: REPO, number })), String(number)).toBe("malformed");
    expect(fake.calls).toHaveLength(0);
    expect(await reasonOf(port.labelTwinSync({ repo: REPO, number: 99 }))).toBe("rejected");
  });

  it("through the pull request kind alone (no issues write) the same call is refused path_refused and nothing is made", async () => {
    const fake = new FakeGithub();
    const repo = fake.addRepo("acme", "widgets-private");
    const port = createRunPullRequestPort({ open: async () => installationKindClient(fake, "runner_pr"), appLogin: async () => FAKE_APP_LOGIN, sleep: async () => undefined });
    expect(await reasonOf(port.labelTwinSync({ repo: REPO, number: 1 }))).toBe("unavailable");
    expect(repo.labels.size).toBe(0);
    expect(fake.denied).toBe(1);
  });

  it("closes the labels client once, whether the calls succeed or one fails", async () => {
    for (const fail of [false, true]) {
      const fake = new FakeGithub();
      const repo = fake.addRepo("acme", "widgets-private");
      fake.pushBranch(repo, BRANCH, { files: [{ path: "a.md", changeType: "MODIFIED" }] });
      const pr = createRunPullRequestPort({ open: async () => installationKindClient(fake, "runner_pr"), appLogin: async () => FAKE_APP_LOGIN, sleep: async () => undefined });
      const ref = await pr.openDraft({ repo: REPO, branch: BRANCH, base: "main", text: { title: "t", body: "b" } });
      if (fail) fake.inject = { label: /A31/, reply: { status: 403, body: { message: "Resource not accessible by integration" } } };
      let closed = 0;
      const port = createRunPullRequestPort({ open: async () => ({ request: (r) => installationKindClient(fake, "setup_labels").request(r), close: async () => void closed++ }), appLogin: async () => FAKE_APP_LOGIN, sleep: async () => undefined });
      if (fail) await expect(port.labelTwinSync({ repo: REPO, number: ref.number })).rejects.toBeInstanceOf(RunPullRequestError);
      else await port.labelTwinSync({ repo: REPO, number: ref.number });
      expect(closed).toBe(1);
    }
  });

  it("the setup_labels client takes the label body for a pull request and nothing else on that path", async () => {
    const fake = new FakeGithub();
    fake.addRepo("acme", "widgets-private");
    const labels = installationKindClient(fake, "setup_labels");
    const headers = { accept: "application/vnd.github+json" };
    for (const req of [
      { method: "PUT", path: "/repos/acme/widgets-private/issues/1/labels", body: { labels: ["fx-twin-sync"] }, headers },
      { method: "POST", path: "/repos/acme/widgets-private/issues/0/labels", body: { labels: ["fx-twin-sync"] }, headers },
      { method: "POST", path: "/repos/acme/widgets-private/issues/1/labels", body: { labels: ["fx-twin-sync"], x: 1 }, headers },
      { method: "POST", path: "/repos/acme/widgets-private/issues/1/comments", body: { labels: ["fx-twin-sync"] }, headers },
    ]) await expect(labels.request(req), `${req.method} ${req.path}`).rejects.toThrow("path_refused");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("commitChanges", () => {
  const BASE_SHA = "a".repeat(40);
  const HEAD_SHA = "b".repeat(40);
  function withCommit(files: Array<{ filename: string; status: string; previous_filename?: string }>) {
    const s = setup();
    s.repo.commits.set(BASE_SHA, []);
    s.repo.commits.set(HEAD_SHA, [BASE_SHA]);
    s.repo.commitFiles.set(HEAD_SHA, files);
    return s;
  }

  it("reads the verified commit's changes against its parent with REST compare, a renamed file's old path included, through the pull request client", async () => {
    const { fake, port, asked } = withCommit([
      { filename: "src/b.ts", status: "renamed", previous_filename: "src/a.ts" },
      { filename: "docs/new.md", status: "added" },
      { filename: "docs/gone.md", status: "removed" },
      { filename: "src/m.ts", status: "modified" },
    ]);
    expect(await port.commitChanges({ repo: REPO, base: BASE_SHA, head: HEAD_SHA })).toEqual({
      files: [
        { path: "src/b.ts", previousPath: "src/a.ts", status: "renamed" },
        { path: "docs/new.md", previousPath: null, status: "added" },
        { path: "docs/gone.md", previousPath: null, status: "removed" },
        { path: "src/m.ts", previousPath: null, status: "modified" },
      ],
      complete: true,
    });
    expect(asked).toEqual([undefined]);
    expect(fake.calls.map((c) => c.label)).toEqual(["A32"]);
    expect(fake.denied).toBe(0);
  });

  it("is incomplete at GitHub's cap of 300 files, so a list that may be cut short is never read as the whole change", async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ filename: `src/f${i}.ts`, status: "added" }));
    expect((await withCommit(many(299)).port.commitChanges({ repo: REPO, base: BASE_SHA, head: HEAD_SHA })).complete).toBe(true);
    expect((await withCommit(many(300)).port.commitChanges({ repo: REPO, base: BASE_SHA, head: HEAD_SHA })).complete).toBe(false);
  });

  it("refuses an id that is not 40 hex before any call, answers rejected for a commit GitHub does not have, and malformed for an answer without the shape", async () => {
    const { fake, port, repo } = withCommit([]);
    for (const [base, head] of [["main", HEAD_SHA], [BASE_SHA, "main"], ["a".repeat(64), "b".repeat(64)], [BASE_SHA.toUpperCase(), HEAD_SHA]] as Array<[string, string]>) expect(await reasonOf(port.commitChanges({ repo: REPO, base, head })), `${base} ${head}`).toBe("malformed");
    expect(fake.calls).toHaveLength(0);
    expect(await reasonOf(port.commitChanges({ repo: REPO, base: BASE_SHA, head: "c".repeat(40) }))).toBe("rejected");
    for (const body of [null, "x", { total_commits: 1 }, { total_commits: 1, files: "no" }, { total_commits: 1, files: [{ status: "added" }] }, { total_commits: 1, files: [{ filename: "a", status: 3 }] }, { total_commits: 1, files: [{ filename: "a", status: "renamed", previous_filename: 4 }] }, { total_commits: "1", files: [] }]) {
      fake.inject = { label: /A32/, reply: { status: 200, body } };
      expect(await reasonOf(port.commitChanges({ repo: REPO, base: BASE_SHA, head: HEAD_SHA })), JSON.stringify(body)).toBe("malformed");
    }
    // more than one commit is not the one verified commit on its parent
    fake.inject = { label: /A32/, reply: { status: 200, body: { total_commits: 2, files: [] } } };
    expect((await port.commitChanges({ repo: REPO, base: BASE_SHA, head: HEAD_SHA })).complete).toBe(false);
    expect(repo.labels.size).toBe(0);
  });

  it("answers unavailable for a GitHub that cannot be asked (a 502, a rate limit)", async () => {
    const { fake, port } = withCommit([]);
    for (const reply of [{ status: 502, body: { message: "Bad Gateway" } }, { status: 403, body: { message: "API rate limit exceeded" } }]) {
      fake.inject = { label: /A32/, reply };
      expect(await reasonOf(port.commitChanges({ repo: REPO, base: BASE_SHA, head: HEAD_SHA }))).toBe("unavailable");
    }
  });
});
