import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOKEN_FORMAT_RE, verifyChecksum } from "../../api/src/tokens/format.js";
import { err, fixture, FixtureServer, newToken, spawnCli, tempHome, type Reply, type Result } from "./helpers.js";

// The canary is a real-shaped token with a valid checksum, so nothing about it is special to the CLI.
const canary = newToken();
const middle = canary.slice(17, 37);
const server = new FixtureServer();
const argvLog: string[][] = [];
beforeAll(async () => void (await server.start()));
afterAll(() => server.stop());

const echoing = err("conflict", `the token ${canary} cannot do that`);
const scenarios: Array<[string, Reply]> = [
  ["200", { status: 200, body: fixture("getAccount", "200-ok.json") }],
  ["401", { status: 401, body: err("invalid_token", `bad token ${canary}`) }],
  ["403 scope", { status: 403, body: fixture("createDiscussion", "403-insufficient_scope.json") }],
  ["403 session_required", { status: 403, body: fixture("createPortalSession", "403-session_required.json") }],
  ["404", { status: 404, body: fixture("deleteToken", "404-not_found.json") }],
  ["409 that echoes the token", { status: 409, body: echoing }],
  ["429 x4", { status: 429, body: fixture("startPlanImport", "429-rate_limited.json"), headers: { "retry-after": "0", "x-echo": canary } }],
  ["500", { status: 500, body: `oops ${canary}` }],
  ["a non-JSON 200", { status: 200, body: `<html>${canary}` }],
  ["a redirect", { status: 302, headers: { location: `http://127.0.0.1:9/?access_token=${canary}` } }],
  // `null` is valid JSON that the command's formatter cannot read: an uncaught exception inside the command.
  ["an uncaught exception", { status: 200, body: "null" }],
];

function assertClean(res: Result, home: string): void {
  for (const text of [res.stdout, res.stderr]) {
    expect(text).not.toContain(canary);
    expect(text).not.toContain(middle);
    expect(text).not.toMatch(/fxat_(?!\[redacted\])/);
  }
  const dir = path.join(home, ".config", "fulcrumaxe");
  for (const name of existsSync(dir) ? readdirSync(dir) : []) if (name !== "credentials.json") expect(readFileSync(path.join(dir, name), "utf8")).not.toContain(middle);
}

describe("no-leak canary", () => {
  it("is shaped like a real token", () => {
    expect(TOKEN_FORMAT_RE.test(canary) && verifyChecksum(canary)).toBe(true);
  });

  // The three input paths (stdin login, FX_TOKEN, the stored file) against every server behaviour, with --debug on, then with --json on.
  it.each(scenarios)("%s", async (_name, reply) => {
    server.reply = () => reply;
    const home = tempHome();
    const login = await spawnCli(home, ["login", "--base-url", server.origin], { stdin: `${canary}\n`, argvLog });
    expect(login.code).toBe(0);
    assertClean(login, home);
    for (const flags of [["--debug"], ["--debug", "--json"]]) {
      const stored = await spawnCli(home, ["whoami", ...flags], { argvLog });
      assertClean(stored, home);
      const viaEnv = await spawnCli(home, ["whoami", ...flags], { env: { FX_TOKEN: canary, FX_BASE_URL: server.origin }, argvLog });
      assertClean(viaEnv, home);
      expect(viaEnv.code).toBe(stored.code);
      if (flags.includes("--json")) expect(() => JSON.parse(viaEnv.stdout)).not.toThrow();
      else expect(viaEnv.stderr).toContain("authorization: [redacted]");
    }
  }, 60_000);

  it("a refused connection", async () => {
    const dead = await new FixtureServer().start();
    const origin = dead.origin;
    await dead.stop();
    const home = tempHome();
    for (const flags of [["--debug"], ["--debug", "--json"]]) {
      const res = await spawnCli(home, ["whoami", ...flags], { env: { FX_TOKEN: canary, FX_BASE_URL: origin }, argvLog });
      expect(res.code).toBe(7);
      assertClean(res, home);
    }
  }, 30_000);

  it("never puts the token in a child's argv", () => {
    expect(argvLog.length).toBeGreaterThan(0);
    for (const argv of argvLog) expect(argv.join(" ")).not.toContain(canary);
  });
});
