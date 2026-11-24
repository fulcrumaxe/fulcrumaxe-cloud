import { describe, expect, it } from "vitest";
import { READY_FALLBACK_LINE, RunPullRequestError, createRunPullRequestPort, type PullRequestRepo } from "../src/runPullRequest.js";
import { FAKE_APP_LOGIN, FakeGithub } from "./helpers/githubFake.js";

/** D#845 ON-8f2a: the install step's additions to the run port: the caller's own pull request text, and the read of one commit's parents. Against the strict fake of GitHub. */
const REPO: PullRequestRepo = { id: "22222222-2222-4222-8222-222222222222", owner: "acme", name: "widgets" };
const SHA = "c".repeat(40);
function setup(over: { drafts?: boolean } = {}) {
  const fake = new FakeGithub();
  const repo = fake.addRepo("acme", "widgets", { supportsDrafts: over.drafts ?? true });
  fake.pushBranch(repo, "fx/engine-install-1.2.3", { files: [{ path: "a.md", changeType: "ADDED" }] });
  const port = createRunPullRequestPort({ open: async () => fake, appLogin: async () => FAKE_APP_LOGIN, sleep: async () => undefined });
  return { fake, repo, port };
}
const reasonOf = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as RunPullRequestError | null)?.reason;

describe("openDraft with the caller's own text", () => {
  it("opens a draft with exactly that title and body, and reuses it on a second call", async () => {
    const { repo, port } = setup();
    const text = { title: "Add the engine (v1.2.3)", body: "Fixed words." };
    const first = await port.openDraft({ repo: REPO, branch: "fx/engine-install-1.2.3", base: "main", text });
    expect(repo.pulls[0]).toMatchObject({ title: text.title, body: text.body, draft: true });
    const again = await port.openDraft({ repo: REPO, branch: "fx/engine-install-1.2.3", base: "main", text });
    expect(again).toMatchObject({ number: first.number, reused: true });
    expect(repo.pulls).toHaveLength(1);
  });

  it("falls back to a ready pull request where drafts are unsupported, with the one fixed line added to the caller's body", async () => {
    const { repo, port } = setup({ drafts: false });
    const ref = await port.openDraft({ repo: REPO, branch: "fx/engine-install-1.2.3", base: "main", text: { title: "t", body: "b" } });
    expect(ref.draft).toBe(false);
    expect(repo.pulls[0]!.body).toBe(`b\n\n${READY_FALLBACK_LINE}`);
  });

  it("needs a run or a text", async () => {
    const { port } = setup();
    expect(await reasonOf(port.openDraft({ repo: REPO, branch: "fx/engine-install-1.2.3", base: "main" }))).toBe("malformed");
  });
});

describe("commitParents", () => {
  it("answers a commit's parent ids, none for a root commit, and null for an id GitHub has no commit of", async () => {
    const { repo, port, fake } = setup();
    repo.commits.set(SHA, ["a".repeat(40)]);
    repo.commits.set("d".repeat(40), []);
    repo.commits.set("e".repeat(40), ["a".repeat(40), "b".repeat(40)]);
    expect(await port.commitParents({ repo: REPO, sha: SHA })).toEqual(["a".repeat(40)]);
    expect(await port.commitParents({ repo: REPO, sha: "d".repeat(40) })).toEqual([]);
    expect(await port.commitParents({ repo: REPO, sha: "e".repeat(40) })).toEqual(["a".repeat(40), "b".repeat(40)]);
    expect(await port.commitParents({ repo: REPO, sha: "f".repeat(40) })).toBeNull();
    expect(fake.calls.every((c) => c.label === "A1 CommitParents")).toBe(true);
    expect(fake.denied).toBe(0);
  });

  it("refuses an id that is not a full commit id before any call, and maps GitHub's failures", async () => {
    const { repo, port, fake } = setup();
    repo.commits.set(SHA, []);
    expect(await reasonOf(port.commitParents({ repo: REPO, sha: "main" }))).toBe("malformed");
    expect(fake.calls).toHaveLength(0);
    fake.inject = { label: /CommitParents/, reply: { status: 502, body: {} } };
    expect(await reasonOf(port.commitParents({ repo: REPO, sha: SHA }))).toBe("unavailable");
    // an answer whose object is another commit, or whose count disagrees with its list, is malformed
    fake.inject = { label: /CommitParents/, reply: { status: 200, body: { data: { repository: { object: { oid: "d".repeat(40), parents: { totalCount: 0, nodes: [] } } } } } } };
    expect(await reasonOf(port.commitParents({ repo: REPO, sha: SHA }))).toBe("malformed");
    fake.inject = { label: /CommitParents/, reply: { status: 200, body: { data: { repository: { object: { oid: SHA, parents: { totalCount: 2, nodes: [{ oid: "a".repeat(40) }] } } } } } } };
    expect(await reasonOf(port.commitParents({ repo: REPO, sha: SHA }))).toBe("malformed");
    // an object that is not a commit selects nothing under the commit fragment: no commit of that id
    fake.inject = { label: /CommitParents/, reply: { status: 200, body: { data: { repository: { object: {} } } } } };
    expect(await port.commitParents({ repo: REPO, sha: SHA })).toBeNull();
  });
});
