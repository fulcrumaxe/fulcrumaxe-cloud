/**
 * issues.ts against a strict local fake of GitHub's Issues API served over real TLS (the fake requires a
 * User-Agent, a Bearer token, and JSON bodies with a JSON content type, as the real service does). What it
 * cannot fake faithfully: GitHub's rate limits and abuse detection, label creation on first use, and the full
 * issue object (only the fields this code reads).
 */
import { afterEach, describe, expect, it } from "vitest";
import { ghError, type GhReply, type GhRequest } from "../../../packages/github/test/helpers/strictGithub.js";
import { startStrictGithubServer, type LocalTlsServer } from "../../../packages/github/test/helpers/localTlsServer.js";
import { main } from "../src/cli.js";
import { GithubError, syncIssues, type IssueOptions } from "../src/issues.js";
import { buildResults, issueTitle, type PackResult } from "../src/report.js";

const TOKEN = "test-bearer-not-a-real-credential-0001";
const REPO = "owner/name";
const SECRET = "planted-runtime-secret-value-98765";

interface FakeIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
  comments: string[];
  pull_request?: object;
}

function json(status: number, body: unknown): GhReply {
  return { status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) };
}

class FakeGithub {
  issues: FakeIssue[] = [];
  private next = 1;
  seed(partial: Partial<FakeIssue> & { title: string }): FakeIssue {
    const issue: FakeIssue = { number: this.next++, body: "", labels: ["live-e2e"], state: "open", comments: [], ...partial };
    this.issues.push(issue);
    return issue;
  }
  route = (req: GhRequest): GhReply => {
    if (req.headers["authorization"] !== `Bearer ${TOKEN}`) return ghError(401, "Bad credentials");
    const m = /^\/repos\/([^/]+\/[^/]+)\/issues(?:\/(\d+)(?:\/(comments|labels))?)?$/.exec(req.path);
    if (!m || m[1] !== REPO) return ghError(404, "Not Found");
    const body = req.body === "" ? {} : (JSON.parse(req.body) as Record<string, unknown>);
    const issue = m[2] === undefined ? undefined : this.issues.find((i) => i.number === Number(m[2]));
    if (m[2] === undefined && req.method === "GET") {
      const q = new URLSearchParams(req.query ?? "");
      const per = Number(q.get("per_page") ?? 30);
      const page = Number(q.get("page") ?? 1);
      const rows = this.issues.filter((i) => i.state === q.get("state") && q.get("labels")!.split(",").every((l) => i.labels.includes(l)));
      return json(200, rows.slice((page - 1) * per, page * per));
    }
    if (m[2] === undefined && req.method === "POST") {
      if (typeof body["title"] !== "string") return ghError(422, "Validation Failed");
      const made = this.seed({ title: body["title"], body: String(body["body"] ?? ""), labels: (body["labels"] as string[] | undefined) ?? [] });
      return json(201, { number: made.number });
    }
    if (issue === undefined) return ghError(404, "Not Found");
    if (m[3] === "comments" && req.method === "POST") {
      issue.comments.push(String(body["body"]));
      return json(201, { id: 1 });
    }
    if (m[3] === "labels" && req.method === "POST") {
      for (const l of body["labels"] as string[]) if (!issue.labels.includes(l)) issue.labels.push(l);
      return json(200, issue.labels.map((name) => ({ name })));
    }
    if (m[3] === undefined && req.method === "PATCH") {
      issue.state = body["state"] as "open" | "closed";
      return json(200, { number: issue.number });
    }
    return ghError(405, "Method Not Allowed");
  };
}

let server: LocalTlsServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(fake: FakeGithub): Promise<IssueOptions> {
  server = await startStrictGithubServer(fake.route);
  return { repo: REPO, token: TOKEN, apiBase: `https://127.0.0.1:${server.port}`, ca: server.ca, runUrl: "https://example.test/run/1", scrub: { values: [SECRET] } };
}

function pack(id: string, outcome: PackResult["outcome"], error?: string): PackResult {
  return { id, outcome, duration_ms: 10, devices: ["desktop"], cost_usd: 0, ...(error !== undefined ? { tests: [{ title: "loads", device: "desktop", status: "failed" as const, duration_ms: 1, error }] } : {}) };
}

function results(target: string, packs: PackResult[]) {
  return buildResults({ target, trigger: "nightly", commit: "abcdef1234567", started_at: "2026-10-08T00:00:00Z", finished_at: "2026-10-08T00:01:00Z", packs });
}

describe("issues: one issue per failing pack", () => {
  it("opens one labelled issue for a failing pack, titled by issueTitle, and none for a passing one", async () => {
    const fake = new FakeGithub();
    const opts = await start(fake);
    const actions = await syncIssues(results("staging", [pack("platform", "FAIL", "expected 200 got 500"), pack("auth-negative", "PASS")]), opts);
    expect(actions).toEqual([{ pack: "auth-negative", action: "none" }, { pack: "platform", action: "created", number: 1 }]);
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0]).toMatchObject({ title: issueTitle("platform", "staging"), labels: ["live-e2e"] });
    expect(fake.issues[0]?.body).toContain("expected 200 got 500");
    expect(fake.issues[0]?.body).toContain("https://example.test/run/1");
    // The strict fake enforces User-Agent and Bearer auth: every request got through them.
    expect(server?.seen.every((r) => r.headers["user-agent"] === "live-e2e")).toBe(true);
  });

  it("a second failure comments on the open issue and opens no new one", async () => {
    const fake = new FakeGithub();
    const opts = await start(fake);
    await syncIssues(results("staging", [pack("platform", "FAIL", "first")]), opts);
    const again = await syncIssues(results("staging", [pack("platform", "FAIL", "second")]), opts);
    expect(again).toEqual([{ pack: "platform", action: "commented", number: 1 }]);
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0]?.comments[0]).toContain("second");
  });

  it("a green run closes the open issue; a skip, a flaky pass and a refusal leave it open", async () => {
    const fake = new FakeGithub();
    const opts = await start(fake);
    for (const id of ["a", "b", "c", "d"]) fake.seed({ title: issueTitle(id, "staging") });
    const out = await syncIssues(results("staging", [pack("a", "PASS"), pack("b", "FLAKY"), pack("c", "SKIPPED-NEED"), pack("d", "REFUSED")]), opts);
    expect(out.map((o) => o.action)).toEqual(["closed", "none", "none", "none"]);
    expect(fake.issues.map((i) => i.state)).toEqual(["closed", "open", "open", "open"]);
  });

  it("an issue for another target, and a pull request with the same title, are not touched", async () => {
    const fake = new FakeGithub();
    const opts = await start(fake);
    fake.seed({ title: issueTitle("platform", "production") });
    fake.seed({ title: issueTitle("platform", "staging"), pull_request: {} });
    await syncIssues(results("staging", [pack("platform", "FAIL", "x")]), opts);
    expect(fake.issues).toHaveLength(3);
    expect(fake.issues[0]?.comments).toEqual([]);
    expect(fake.issues[1]?.comments).toEqual([]);
  });

  it("finds the open issue on the second page of the listing", async () => {
    const fake = new FakeGithub();
    const opts = await start(fake);
    for (let i = 0; i < 100; i += 1) fake.seed({ title: `unrelated ${i}` });
    const target = fake.seed({ title: issueTitle("platform", "staging") });
    await syncIssues(results("staging", [pack("platform", "FAIL", "x")]), opts);
    expect(fake.issues).toHaveLength(101);
    expect(target.comments).toHaveLength(1);
  });

  it("a production failure opens with needs-owner, and an existing production issue gains it", async () => {
    const fake = new FakeGithub();
    const opts = await start(fake);
    await syncIssues(results("production", [pack("platform", "FAIL", "x")]), opts);
    expect(fake.issues[0]?.labels).toEqual(["live-e2e", "needs-owner"]);
    const old = fake.seed({ title: issueTitle("auth-negative", "production") });
    await syncIssues(results("production", [pack("auth-negative", "FAIL", "y")]), opts);
    expect(old.labels).toContain("needs-owner");
  });
});

describe("issues: nothing secret reaches GitHub", () => {
  it("a secret planted in a failure message is not in the issue body or any request", async () => {
    const fake = new FakeGithub();
    const opts = await start(fake);
    await syncIssues(results("staging", [pack("platform", "FAIL", `request failed with key ${SECRET} in the url`)]), opts);
    expect(fake.issues[0]?.body).toContain("request failed");
    expect(fake.issues[0]?.body).not.toContain(SECRET);
    expect(JSON.stringify(server?.seen)).not.toContain(SECRET);
  });

  it("the token goes only in the Authorization header", async () => {
    const fake = new FakeGithub();
    const opts = await start(fake);
    await syncIssues(results("staging", [pack("platform", "FAIL", "x")]), opts);
    for (const r of server?.seen ?? []) {
      expect(r.body).not.toContain(TOKEN);
      expect(r.path + (r.query ?? "")).not.toContain(TOKEN);
    }
  });

  it("a refusal names the status and route, not the token or the response body", async () => {
    const fake = new FakeGithub();
    const opts = await start(fake);
    const err = await syncIssues(results("staging", [pack("platform", "FAIL", "x")]), { ...opts, token: "wrong-bearer-not-a-real-credential-0002" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubError);
    expect((err as GithubError).status).toBe(401);
    expect((err as GithubError).message).not.toContain("wrong-bearer");
    expect((err as GithubError).message).not.toContain("Bad credentials");
  });

  it("refuses a plain-http API address before sending anything", async () => {
    await expect(syncIssues(results("staging", [pack("platform", "FAIL", "x")]), { repo: REPO, token: TOKEN, apiBase: "http://127.0.0.1:1", scrub: {} })).rejects.toThrow("https");
  });

  it("rejects a repo that is not owner/name", async () => {
    await expect(syncIssues(results("staging", []), { repo: "owner/name/../x", token: TOKEN, scrub: {} })).rejects.toThrow("owner/name");
  });
});

describe("cli: live-e2e issues", () => {
  it("reads results.json and acts through GITHUB_API_URL and GITHUB_TOKEN; prints one line per pack", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const fake = new FakeGithub();
    const opts = await start(fake);
    const dir = mkdtempSync(join(tmpdir(), "le2e-issues-"));
    writeFileSync(join(dir, "results.json"), JSON.stringify(results("staging", [pack("platform", "FAIL", "boom")])));
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["issues", "--results", "results.json", "--repo", REPO], {
      root: dir,
      cwd: dir,
      env: { GITHUB_TOKEN: TOKEN, GITHUB_API_URL: opts.apiBase },
      host: { loadavg1: 0, memAvailableKb: 1e9 } as never,
      githubCa: opts.ca as string,
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    });
    expect({ code, out, err }).toEqual({ code: 0, out: ["issues: platform created #1"], err: [] });
  });

  it("is a usage error without a token", async () => {
    const err: string[] = [];
    const code = await main(["issues", "--results", "r.json", "--repo", REPO], { root: ".", cwd: ".", env: {}, host: {} as never, stdout: () => undefined, stderr: (l) => err.push(l) });
    expect(code).toBe(2);
    expect(err[0]).toContain("usage");
  });
});
