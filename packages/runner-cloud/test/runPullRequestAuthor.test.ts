import { describe, expect, it } from "vitest";
import { RunPullRequestError, createRunPullRequestPort, type PullRequestRepo } from "../src/runPullRequest.js";
import { FAKE_APP_LOGIN, FakeGithub } from "./helpers/githubFake.js";

/**
 * D#6 R2b-3f (TL, from the #71 review): an open pull request on the run's branch is reused only if OUR App opened it. The choice is
 * fail closed: any other author is `rejected` (the run then ends `pr_rejected`), the branch is kept, and no second pull request is
 * attempted.
 */
const REPO: PullRequestRepo = { id: "22222222-2222-4222-8222-222222222222", owner: "acme", name: "widgets" };
const RUN = { runId: "33333333-3333-4333-8333-333333333333", workItemId: "44444444-4444-4444-8444-444444444444", workItemTitle: "Add the footer" };
const BRANCH = `fx/${RUN.runId}-g1`;
const ours = { login: FAKE_APP_LOGIN, type: "Bot" as const };
const person = { login: "octocat", type: "User" as const };

function setup(appLogin: () => Promise<string> = async () => FAKE_APP_LOGIN) {
  const fake = new FakeGithub();
  const repo = fake.addRepo("acme", "widgets");
  fake.pushBranch(repo, BRANCH, { files: [{ path: "src/a.ts", changeType: "MODIFIED" }], aheadBy: 1 });
  const port = createRunPullRequestPort({ open: async () => fake, appLogin });
  return { fake, repo, port, open: () => port.openDraft({ repo: REPO, branch: BRANCH, base: "main", run: RUN }) };
}
const labels = (f: FakeGithub) => f.calls.map((c) => c.label);
const failure = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as RunPullRequestError;

describe("reusing an open pull request: it must have been opened by our App", () => {
  it("reuses one our App opened (its login, type Bot), matching the login case-insensitively", async () => {
    const { fake, repo, open } = setup();
    fake.addForeignPull(repo, { head: BRANCH, author: { login: FAKE_APP_LOGIN.toUpperCase(), type: "Bot" } });
    expect(await open()).toMatchObject({ number: 1, reused: true });
    expect(labels(fake)).toEqual(["A3"]);
  });

  it("a person's pull request on the branch is rejected: nothing is created, closed or reused", async () => {
    const { fake, repo, open } = setup();
    fake.addForeignPull(repo, { head: BRANCH, author: person });
    const err = await failure(open());
    expect(err).toBeInstanceOf(RunPullRequestError);
    expect(err.reason).toBe("rejected");
    expect(err.status).toBeUndefined();
    expect(labels(fake)).toEqual(["A3"]);
    expect(repo.pulls).toHaveLength(1);
    expect(repo.pulls[0]!.state).toBe("open");
  });

  it("another App's bot is not ours, and a person whose login looks like ours is not a Bot", async () => {
    for (const author of [
      { login: "some-other-app[bot]", type: "Bot" as const },
      { login: FAKE_APP_LOGIN, type: "User" as const },
    ]) {
      const { fake, repo, open } = setup();
      fake.addForeignPull(repo, { head: BRANCH, author });
      expect((await failure(open())).reason, `${author.login} ${author.type}`).toBe("rejected");
      expect(repo.pulls).toHaveLength(1);
    }
  });

  it("a listing item with no `user` at all is not ours", async () => {
    const { fake, open } = setup();
    fake.inject = {
      label: /^A3$/,
      reply: { status: 200, body: [{ number: 9, node_id: "PR_x", state: "open", draft: true, head: { ref: BRANCH, repo: { full_name: "acme/widgets" } }, base: { ref: "main" } }] },
    };
    expect((await failure(open())).reason).toBe("rejected");
  });

  it("if any of the pull requests on the branch is somebody else's, none is reused", async () => {
    const { fake, repo, open } = setup();
    fake.addForeignPull(repo, { head: BRANCH, author: ours });
    fake.addForeignPull(repo, { head: BRANCH, author: person });
    expect((await failure(open())).reason).toBe("rejected");
  });

  it("the race path obeys the same rule: a pull request somebody else opens between our look and our create is rejected", async () => {
    const { fake, repo, open } = setup();
    fake.before = (req) => {
      if (req.method === "POST" && repo.pulls.length === 0) fake.addForeignPull(repo, { head: BRANCH, author: person });
    };
    expect((await failure(open())).reason).toBe("rejected");
    expect(repo.pulls).toHaveLength(1);
  });

  it("asks for our login only when there is a pull request to judge", async () => {
    const asked: number[] = [];
    const { open } = setup(async () => (asked.push(1), FAKE_APP_LOGIN));
    await open();
    expect(asked).toEqual([]);
  });

  it("a failure to learn our login is `unavailable` (retried) and never echoes its cause; an empty login is `rejected`", async () => {
    for (const [login, expected] of [
      [async () => Promise.reject(new Error("jwt: secret-key-material")), "unavailable"],
      [async () => "", "rejected"],
    ] as const) {
      const { fake, repo, open } = setup(login);
      fake.addForeignPull(repo, { head: BRANCH, author: ours });
      const err = await failure(open());
      expect(err.reason).toBe(expected);
      expect(err.message).not.toContain("secret");
    }
  });

  it("a permanent refusal carries GitHub's HTTP status and nothing else of its answer", async () => {
    const refused = setup();
    refused.fake.inject = { label: /^A4$/, reply: { status: 422, body: { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "secret-looking text" }] } } };
    const err = await failure(refused.open());
    expect(err.reason).toBe("rejected");
    expect(err.status).toBe(422);
    expect(err.message).toBe("run pull request: rejected");
  });
});
