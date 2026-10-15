import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isSessionOnly, SESSION_ONLY } from "../src/links.js";
import { err, fixture, FixtureServer, newToken, run, tempHome, type Reply, type Seen } from "./helpers.js";

const server = new FixtureServer();
const token = newToken();
const ID = "11111111-1111-4111-8111-111111111111";
// The work item the recorded run fixtures point at.
const WORK_ITEM = "22222222-2222-4222-8222-222222222222";
let home: string;
beforeAll(async () => void (await server.start()));
afterAll(() => server.stop());
beforeEach(() => {
  server.seen = [];
  home = tempHome();
  server.reply = answer({});
});

const fx = (argv: string[], extra: Record<string, string> = {}) => run(home, argv, { env: { FX_TOKEN: token, FX_BASE_URL: server.origin, ...extra } });

/** Answers each API path with a recorded fixture, and 404 like the real API for any path it does not know. */
function answer(overrides: Record<string, Reply>): (req: Seen) => Reply {
  const routes: Record<string, [string, string]> = {
    "/api/v1/runs": ["listRuns", "200-page.json"],
    [`/api/v1/runs/${ID}`]: ["getRun", "200-running.json"],
    "/api/v1/work-items": ["listWorkItems", "200-page.json"],
    [`/api/v1/work-items/${ID}`]: ["getWorkItem", "200-in-review.json"],
    [`/api/v1/work-items/${WORK_ITEM}`]: ["getWorkItem", "200-in-review.json"],
    [`/api/v1/work-items/${ID}/timeline`]: ["getWorkItemTimeline", "200-ok.json"],
    "/api/v1/discussions": ["listDiscussions", "200-page.json"],
    [`/api/v1/discussions/${ID}`]: ["getDiscussion", "200-detail.json"],
    [`/api/v1/discussions/${ID}/comments`]: ["listComments", "200-page.json"],
    "/api/v1/repos": ["listRepos", "200-page.json"],
    [`/api/v1/repos/${ID}`]: ["getRepo", "200-installed.json"],
    "/api/v1/webhook-endpoints": ["listWebhookEndpoints", "200-page.json"],
    [`/api/v1/webhook-endpoints/${ID}`]: ["getWebhookEndpoint", "200-ok.json"],
    [`/api/v1/webhook-endpoints/${ID}/deliveries`]: ["listWebhookDeliveries", "200-page.json"],
    "/api/v1/usage": ["getUsage", "200-ok.json"],
    "/api/v1/budgets": ["getBudgets", "200-ok.json"],
  };
  return (req) => {
    const path = new URL(req.url, "http://x").pathname;
    const override = overrides[path];
    if (override) return override;
    const hit = routes[path];
    if (req.method !== "GET" || !hit) return { status: 404, body: err("not_found") };
    if (req.headers["authorization"] !== `Bearer ${token}`) return { status: 401, body: err("invalid_token") };
    return { status: 200, body: fixture(hit[0], hit[1]) };
  };
}

// argv, the operation it calls, the fixture it is shown against, and how many requests a person's (human) run makes.
const commands: Array<[string[], string, string, number]> = [
  [["runs", "list"], "listRuns", "200-page.json", 2],
  [["runs", "show", ID], "getRun", "200-running.json", 2],
  [["work-items", "list"], "listWorkItems", "200-page.json", 1],
  [["work-items", "show", ID], "getWorkItem", "200-in-review.json", 1],
  [["work-items", "timeline", ID], "getWorkItemTimeline", "200-ok.json", 1],
  [["discussions", "list"], "listDiscussions", "200-page.json", 1],
  [["discussions", "show", ID], "getDiscussion", "200-detail.json", 1],
  [["discussions", "comments", ID], "listComments", "200-page.json", 1],
  [["repos", "list"], "listRepos", "200-page.json", 1],
  [["repos", "show", ID], "getRepo", "200-installed.json", 1],
  [["webhooks", "list"], "listWebhookEndpoints", "200-page.json", 1],
  [["webhooks", "show", ID], "getWebhookEndpoint", "200-ok.json", 1],
  [["webhooks", "deliveries", ID], "listWebhookDeliveries", "200-page.json", 1],
  [["usage"], "getUsage", "200-ok.json", 1],
  [["budgets"], "getBudgets", "200-ok.json", 1],
];

describe("read commands", () => {
  it.each(commands)("%j: human output, no null or undefined, and only the requests the ruling allows", async (argv, _op, _file, requests) => {
    const res = await fx(argv);
    expect(res.code).toBe(0);
    expect(res.stdout.length).toBeGreaterThan(0);
    expect(res.stdout).not.toMatch(/\bnull\b|\bundefined\b/);
    // The only thing a read may say on stderr is that the recorded page has a next page.
    expect(res.stderr.replace(/^There are more results:.*\n/, "")).toBe("");
    expect(server.seen).toHaveLength(requests);
    expect(server.seen.every((s) => s.method === "GET" && s.headers["authorization"] === `Bearer ${token}`)).toBe(true);
  });

  it.each(commands)("%j --json: the recorded body, unchanged, in one envelope and one request", async (argv, op, file) => {
    const res = await fx([...argv, "--json"]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ v: 1, data: JSON.parse(fixture(op, file)) });
    expect(server.seen).toHaveLength(1);
  });

  it("every list fixture renders without null or undefined, including a repo with no name and a deleted comment", async () => {
    const repos = await fx(["repos", "list"]);
    expect(repos.stdout).toContain("acme/widgets");
    expect(repos.stdout).toMatch(/docs {2}\(not installed\)/);
    const comments = await fx(["discussions", "comments", ID]);
    expect(comments.stdout).toContain("(deleted)");
    expect(comments.stdout).toContain("replying to 44444444-4444-4444-8444-444444444444");
    expect(`${repos.stdout}${comments.stdout}`).not.toMatch(/\bnull\b|\bundefined\b/);
  });

  it("a work item with no title still has a name people can read", async () => {
    server.reply = answer({ "/api/v1/work-items": { status: 200, body: JSON.stringify({ data: [{ ...JSON.parse(fixture("listWorkItems", "200-page.json")).data[0], title: null }], next_cursor: null }) } });
    const res = await fx(["work-items", "list"]);
    expect(res.stdout).toContain("(untitled)");
    expect(res.stdout).not.toContain("null");
  });
});

describe("run titles (one extra read, never more)", () => {
  it("runs list prints the work item's title beside each run, from one listWorkItems page", async () => {
    const res = await fx(["runs", "list"]);
    expect(res.stdout).toContain("11111111-1111-4111-8111-111111111111  succeeded  build  Add a dark mode toggle (22222222-2222-4222-8222-222222222222)");
    expect(server.seen.map((s) => new URL(s.url, "http://x").pathname)).toEqual(["/api/v1/runs", "/api/v1/work-items"]);
  });

  it("a title that is not on that page leaves the bare work item id", async () => {
    server.reply = answer({ "/api/v1/work-items": { status: 200, body: JSON.stringify({ data: [], next_cursor: null }) } });
    const res = await fx(["runs", "list"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("build  22222222-2222-4222-8222-222222222222  $1.25");
    expect(res.stdout).not.toContain("(22222222");
  });

  it("runs show reads the work item once for its title; a work item that is gone leaves the bare id and the run still shows", async () => {
    const ok = await fx(["runs", "show", ID]);
    expect(ok.stdout).toContain("work item: Add a dark mode toggle (22222222-2222-4222-8222-222222222222)");
    server.seen = [];
    server.reply = answer({ "/api/v1/work-items/22222222-2222-4222-8222-222222222222": { status: 404, body: err("not_found") } });
    const gone = await fx(["runs", "show", ID]);
    expect(gone.code).toBe(0);
    expect(gone.stdout).toContain("work item: 22222222-2222-4222-8222-222222222222");
    expect(server.seen).toHaveLength(2);
  });

  it("a failed title read that is not a 404 is reported, not hidden", async () => {
    server.reply = answer({ "/api/v1/work-items/22222222-2222-4222-8222-222222222222": { status: 401, body: err("invalid_token") } });
    expect((await fx(["runs", "show", ID])).code).toBe(3);
  });

  it("a run with no work item asks for no title at all", async () => {
    const body = JSON.parse(fixture("listRuns", "200-page.json"));
    body.data[0].work_item_id = null;
    server.reply = answer({ "/api/v1/runs": { status: 200, body: JSON.stringify(body) } });
    const res = await fx(["runs", "list"]);
    expect(res.code).toBe(0);
    expect(server.seen).toHaveLength(1);
    expect(res.stdout).not.toMatch(/\bnull\b|\bundefined\b/);
  });
});

describe("paging", () => {
  const page = (ids: string[], next: string | null): Reply => ({ status: 200, body: JSON.stringify({ data: ids.map((id) => ({ ...JSON.parse(fixture("listRepos", "200-page.json")).data[0], id, full_name: `acme/${id.slice(0, 4)}` })), next_cursor: next }) });
  const a = "aaaa0000-0000-4000-8000-000000000000";
  const b = "bbbb0000-0000-4000-8000-000000000000";

  it("shows one page, says there is more, and sends --limit as the page size", async () => {
    server.reply = () => page([a], "c2");
    const res = await fx(["repos", "list", "--limit", "1"]);
    expect(server.seen).toHaveLength(1);
    expect(new URL(server.seen[0]!.url, "http://x").searchParams.get("limit")).toBe("1");
    expect(res.stdout).toContain("acme/aaaa");
    expect(res.stdout).not.toContain("acme/bbbb");
    expect(res.stderr).toContain("--all");
    expect(res.stdout).not.toContain("c2");
  });

  it("--all follows next_cursor to the end and merges the pages under --json", async () => {
    server.reply = (req) => (new URL(req.url, "http://x").searchParams.get("cursor") === "c2" ? page([b], null) : page([a], "c2"));
    const human = await fx(["repos", "list", "--all"]);
    expect(human.stdout).toContain("acme/aaaa");
    expect(human.stdout).toContain("acme/bbbb");
    expect(human.stderr).toBe("");
    expect(server.seen).toHaveLength(2);
    const json = JSON.parse((await fx(["repos", "list", "--all", "--json"])).stdout);
    expect(json.data.data.map((r: { id: string }) => r.id)).toEqual([a, b]);
    expect(json.data.next_cursor).toBeNull();
  });

  it("a server that repeats a cursor stops the CLI with exit 1", async () => {
    server.reply = () => page([a], "same");
    const res = await fx(["repos", "list", "--all"]);
    expect(res.code).toBe(1);
    expect(server.seen).toHaveLength(2);
  });

  it("a bad --limit exits 2 without a request", async () => {
    for (const v of ["0", "-1", "abc", "1000", "1.5"]) expect((await fx(["repos", "list", "--limit", v])).code).toBe(2);
    expect(server.seen).toHaveLength(0);
  });
});

describe("arguments", () => {
  it("a missing, extra or malformed id exits 2 with no request; so does an unknown subcommand", async () => {
    for (const argv of [["runs", "show"], ["runs", "show", ID, ID], ["runs", "show", "nope"], ["runs", "show", ".."], ["runs", "list", ID], ["runs", "bogus"], ["usage", "x"], ["budgets", "x"]]) {
      expect((await fx(argv)).code, argv.join(" ")).toBe(2);
    }
    expect(server.seen).toHaveLength(0);
  });

  it("a 404 is exit 4 and a missing scope is exit 9 naming the scope", async () => {
    server.reply = () => ({ status: 404, body: fixture("getDiscussion", "404-not_found.json") });
    expect((await fx(["discussions", "show", ID])).code).toBe(4);
    server.reply = () => ({ status: 403, body: err("insufficient_scope") });
    const res = await fx(["runs", "list"]);
    expect(res.code).toBe(9);
    expect(res.stderr).toContain("`read` scope");
  });

  it("a 200 the formatter cannot read exits 1 with fixed text, as one envelope under --json", async () => {
    server.reply = () => ({ status: 200, body: "null" });
    const human = await fx(["repos", "list"]);
    expect(human.code).toBe(1);
    expect(human.stderr).toBe("error: unexpected error: run again with --debug for details\n");
    expect(JSON.parse((await fx(["repos", "list", "--json"])).stdout).error.exit).toBe(1);
  });

  it("the token never reaches the output, even with --debug", async () => {
    const res = await fx(["runs", "list", "--debug"]);
    expect(`${res.stdout}${res.stderr}`).not.toContain(token);
    expect(res.stderr).toContain("authorization: [redacted]");
  });
});

describe("session-only pointers", () => {
  const actions = Object.keys(SESSION_ONLY);

  it("the table covers exactly the commands the Spec lists", () => {
    expect(actions.sort()).toEqual(
      ["webhooks add", "webhooks test", "webhooks edit", "webhooks delete", "webhooks rotate-secret", "sites", "runs retry", "work-items approve", "work-items close", "work-items reopen", "work-items respec", "budgets set", "tokens"].sort(),
    );
  });

  it.each(actions)("%s: exit 6, one line, a link under the profile origin, and no request", async (action) => {
    const res = await fx([...action.split(" "), ID]);
    expect(res.code).toBe(6);
    expect(server.seen).toHaveLength(0);
    expect(res.stdout).toBe("");
    const lines = res.stderr.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^error: ${action} needs the workspace \\(tokens can't do this by design\\): ${server.origin.replace(/[.]/g, "\\.")}/\\S*$`));
    expect(lines[0]).not.toContain("undefined");
    const json = JSON.parse((await fx([...action.split(" "), "--json"])).stdout);
    expect(json.error.exit).toBe(6);
    expect(json.error.link.startsWith(server.origin)).toBe(true);
    expect(json.error.link).not.toContain("undefined");
  });

  it("sites and tokens are pointers whatever follows them", async () => {
    for (const argv of [["sites"], ["sites", "list"], ["tokens", "create", "--json"]]) expect((await fx(argv)).code).toBe(6);
    expect(server.seen).toHaveLength(0);
  });

  it("only listed actions are pointers", () => {
    expect(isSessionOnly("runs list")).toBe(false);
    expect(isSessionOnly("toString")).toBe(false);
  });

  it("a pointer needs a profile to know the origin: with no login it is exit 3, still without a request", async () => {
    const res = await run(home, ["webhooks", "add"]);
    expect(res.code).toBe(3);
    expect(server.seen).toHaveLength(0);
  });

  it("a server 403 session_required on any other command is the same exit 6", async () => {
    server.reply = () => ({ status: 403, body: fixture("createPortalSession", "403-session_required.json") });
    const res = await fx(["usage"]);
    expect(res.code).toBe(6);
    expect(res.stderr).toContain("needs the workspace (tokens can't do this by design)");
    expect(res.stderr).toContain(server.origin);
  });
});
