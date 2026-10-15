import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EXIT_TABLE } from "../src/errors.js";
import { err, fixture, FixtureServer, newToken, run, tempHome, type Reply } from "./helpers.js";

const server = new FixtureServer();
const token = newToken();
let home: string;
beforeAll(async () => void (await server.start()));
afterAll(() => server.stop());
beforeEach(() => {
  server.seen = [];
  home = tempHome();
});

const whoami = (extra: string[] = [], base = server.origin) => run(home, ["whoami", ...extra], { env: { FX_TOKEN: token, FX_BASE_URL: base } });

// One row per exit code: the status the fixture server answers with, and the code the CLI must exit with.
const rows: Array<[number, string, Reply | null]> = [
  [0, "2xx", { status: 200, body: fixture("getAccount", "200-ok.json") }],
  [1, "5xx", { status: 500, body: "boom" }],
  [1, "an unreadable 2xx body", { status: 200, body: "<html>" }],
  [3, "401 invalid_token", { status: 401, body: err("invalid_token") }],
  [4, "404", { status: 404, body: fixture("deleteToken", "404-not_found.json") }],
  [5, "429 rate_limited after retries", { status: 429, body: fixture("startPlanImport", "429-rate_limited.json"), headers: { "retry-after": "0" } }],
  [6, "403 session_required", { status: 403, body: fixture("createPortalSession", "403-session_required.json") }],
  [8, "429 stream_limit after retries", { status: 429, body: err("stream_limit"), headers: { "retry-after": "0" } }],
  [9, "403 insufficient_scope", { status: 403, body: fixture("createDiscussion", "403-insufficient_scope.json") }],
  [9, "403 role below the minimum", { status: 403, body: fixture("createPortalSession", "403-insufficient_role.json") }],
  [10, "409 not_cancellable", { status: 409, body: fixture("cancelRun", "409-not_cancellable.json") }],
  [10, "422 refusal", { status: 422, body: fixture("createCheckoutSession", "422-invalid_plan.json") }],
];

describe("exit codes", () => {
  it.each(rows)("%i: %s", async (exit, _name, reply) => {
    server.reply = () => reply!;
    const human = await whoami();
    expect(human.code).toBe(exit);
    const json = await whoami(["--json"]);
    expect(json.code).toBe(exit);
    const body = JSON.parse(json.stdout) as { v: number; data?: unknown; error?: { exit: number } };
    expect(body.v).toBe(1);
    if (exit === 0) expect(body.data).toEqual(JSON.parse(reply!.body!));
    else expect(body.error?.exit).toBe(exit);
  });

  it("7: a refused connection", async () => {
    const dead = await new FixtureServer().start();
    const origin = dead.origin;
    await dead.stop();
    const res = await whoami(["--json"], origin);
    expect(res.code).toBe(7);
    expect(JSON.parse(res.stdout).error.exit).toBe(7);
  });

  it("2: usage errors, with no request", async () => {
    for (const argv of [["--bogus"], ["nope"], [], ["whoami", "--profile", "bad name!"]]) expect((await run(home, argv, { env: { FX_TOKEN: token, FX_BASE_URL: server.origin } })).code).toBe(2);
    expect(server.seen).toHaveLength(0);
  });

  it("3: no token, a malformed FX_TOKEN (without a request), a refused 401 message naming every cause", async () => {
    expect((await run(home, ["whoami"])).code).toBe(3);
    const bad = await run(home, ["whoami"], { env: { FX_TOKEN: "fxat_short", FX_BASE_URL: server.origin } });
    expect(bad.code).toBe(3);
    expect(server.seen).toHaveLength(0);
    server.reply = () => ({ status: 401, body: err("invalid_token") });
    expect((await whoami()).stderr).toMatch(/wrong, expired, revoked, or its creator is no longer a member.*then run `fx login`/);
  });

  it("9: names the scope the operation needs", async () => {
    server.reply = () => ({ status: 403, body: err("insufficient_scope") });
    expect((await whoami()).stderr).toContain("`read` scope");
  });

  it("--help prints every row of the table and exits 0", async () => {
    const res = await run(home, ["--help"]);
    expect(res.code).toBe(0);
    for (const [code, meaning] of EXIT_TABLE) expect(res.stdout).toContain(`${String(code).padStart(2)}  ${meaning}`);
  });
});

describe("429", () => {
  it("waits at least Retry-After between requests and stops after 3 retries", async () => {
    server.reply = () => ({ status: 429, body: err("rate_limited"), headers: { "retry-after": "1" } });
    const res = await run(home, ["whoami"], { env: { FX_TOKEN: token, FX_BASE_URL: server.origin }, realSleep: true });
    expect(res.code).toBe(5);
    expect(server.seen).toHaveLength(4);
    for (let i = 1; i < 4; i++) expect(server.seen[i]!.at - server.seen[i - 1]!.at).toBeGreaterThanOrEqual(1000);
  }, 20_000);

  it("a Retry-After over 60 s exits at once and prints the wait", async () => {
    server.reply = () => ({ status: 429, body: err("rate_limited"), headers: { "retry-after": "61" } });
    const res = await whoami();
    expect(res.code).toBe(5);
    expect(res.stderr).toContain("61s");
    expect(server.seen).toHaveLength(1);
  });
});
