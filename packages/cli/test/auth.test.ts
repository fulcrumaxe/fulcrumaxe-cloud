import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { err, fixture, FixtureServer, newToken, run, tempHome } from "./helpers.js";

const server = new FixtureServer();
const other = new FixtureServer();
const token = newToken();
let home: string;
let dir: string;
const cred = (): string => path.join(dir, "credentials.json");
beforeAll(async () => void (await Promise.all([server.start(), other.start()])));
afterAll(() => Promise.all([server.stop(), other.stop()]));
beforeEach(() => {
  server.seen = [];
  other.seen = [];
  server.reply = () => ({ status: 200, body: fixture("getAccount", "200-ok.json") });
  home = tempHome();
  dir = path.join(home, ".config", "fulcrumaxe");
});
const login = (args: string[] = [], stdin = `${token}\n`) => run(home, ["login", "--base-url", server.origin, ...args], { stdin });

describe("login", () => {
  it("reads the token from stdin, saves it at 0600 in a 0700 directory, and whoami uses it", async () => {
    const res = await login(["--profile", "staging"]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain(`${server.origin}`);
    expect(statSync(cred()).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(path.join(dir, "config.json"), "utf8")).not.toContain(token);
    const who = await run(home, ["--profile", "staging", "whoami"]);
    expect(who.code).toBe(0);
    expect(who.stdout).toContain(`token: ...${token.slice(-4)}`);
    expect(who.stdout).not.toContain(token);
    expect(server.seen[0]!.headers["authorization"]).toBe(`Bearer ${token}`);
  });

  it("has no --token flag: any form exits 2 with a fixed message that does not echo the value", async () => {
    for (const argv of [["login", "--token", token], ["login", `--token=${token}`], ["login", "-t", "x"], ["login", token]]) {
      const res = await run(home, argv);
      expect(res.code).toBe(2);
      expect(res.stderr).toContain("never be passed on the command line");
      expect(res.stderr).not.toContain(token);
    }
    expect(existsSync(cred())).toBe(false);
  });

  it("refuses input that is not a token, without echoing it", async () => {
    const res = await login([], "hunter2\n");
    expect(res.code).toBe(2);
    expect(res.stderr).not.toContain("hunter2");
  });

  it.each(["http://example.com", "https://u:p@x.example", "https://x.example/path", "https://x.example?q=1", "ftp://x.example", "not a url"])("refuses the base URL %s with exit 2", async (url) => {
    const res = await run(home, ["login", "--base-url", url], { stdin: `${token}\n` });
    expect(res.code).toBe(2);
    expect(existsSync(cred())).toBe(false);
  });

  it("accepts https and http on loopback only", async () => {
    for (const url of ["https://x.example", "http://localhost:3000", "http://[::1]:3000", "http://127.0.0.1"]) expect((await run(home, ["login", "--base-url", url], { stdin: `${token}\n` })).code).toBe(0);
  });

  it("needs --base-url while no production origin is named", async () => {
    expect((await run(home, ["login"], { stdin: `${token}\n` })).code).toBe(2);
  });

  it("on Windows a stored login is refused with exit 2, and FX_TOKEN still works", async () => {
    expect((await run(home, ["login", "--base-url", server.origin], { stdin: `${token}\n`, platform: "win32" })).code).toBe(2);
    expect((await run(home, ["whoami"], { platform: "win32" })).code).toBe(2);
    expect((await run(home, ["whoami"], { platform: "win32", env: { FX_TOKEN: token, FX_BASE_URL: server.origin } })).code).toBe(0);
  });
});

describe("credential file safety", () => {
  beforeEach(async () => void (await login()));

  const refused = async (): Promise<void> => {
    const res = await run(home, ["whoami"]);
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("not safe to use");
    expect(res.stderr).not.toContain(token);
    expect(server.seen).toHaveLength(0);
  };

  it("refuses a group- or world-readable file with exit 3", async () => {
    chmodSync(cred(), 0o644);
    await refused();
  });

  it("refuses a symlinked file with exit 3", async () => {
    const real = path.join(home, "real.json");
    writeFileSync(real, readFileSync(cred()), { mode: 0o600 });
    rmSync(cred());
    symlinkSync(real, cred());
    await refused();
  });

  it("refuses a symlinked directory with exit 3", async () => {
    const elsewhere = path.join(home, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    renameSync(dir, path.join(elsewhere, "fulcrumaxe"));
    symlinkSync(path.join(elsewhere, "fulcrumaxe"), dir);
    await refused();
  });

  it("refuses a file owned by another user", async () => {
    const res = await run(home, ["whoami"], { uid: (process.getuid?.() ?? 0) + 1 });
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("belongs to another user");
  });
});

describe("origin binding and redirects", () => {
  it("sends nothing and exits 3 when the profile's origin was edited after login", async () => {
    await login();
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ profiles: { default: other.origin } }));
    const res = await run(home, ["whoami"]);
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("log in again");
    expect(server.seen.length + other.seen.length).toBe(0);
  });

  it("never follows a redirect: the second origin sees nothing, and the exit is 1", async () => {
    server.reply = () => ({ status: 302, headers: { location: `${other.origin}/api/v1/account` } });
    const res = await run(home, ["whoami"], { env: { FX_TOKEN: token, FX_BASE_URL: server.origin } });
    expect(res.code).toBe(1);
    expect(server.seen).toHaveLength(1);
    expect(other.seen).toHaveLength(0);
  });
});

describe("precedence", () => {
  it("FX_TOKEN beats the stored login, FX_BASE_URL beats the profile origin, --profile beats FX_PROFILE", async () => {
    await login();
    await run(home, ["login", "--profile", "alt", "--base-url", other.origin], { stdin: `${newToken()}\n` });
    other.reply = () => ({ status: 200, body: fixture("getAccount", "200-ok.json") });
    const viaEnv = newToken();
    await run(home, ["whoami"], { env: { FX_TOKEN: viaEnv, FX_BASE_URL: other.origin } });
    expect(other.seen[0]!.headers["authorization"]).toBe(`Bearer ${viaEnv}`);
    expect(server.seen).toHaveLength(0);
    await run(home, ["--profile", "default", "whoami"], { env: { FX_PROFILE: "alt" } });
    expect(server.seen).toHaveLength(1);
  });

  it("an unknown profile exits 2 and lists the existing ones as name (origin)", async () => {
    await login();
    const res = await run(home, ["whoami", "--profile", "nope"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain(`default (${server.origin})`);
  });
});

describe("logout and whoami", () => {
  it("logout is local only: it removes the credential, says the token still works, and whoami then exits 3", async () => {
    await login();
    const res = await run(home, ["logout"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("The token still works until it expires or is revoked");
    expect(res.stdout).toContain(server.origin);
    expect(existsSync(cred())).toBe(false);
    expect(server.seen).toHaveLength(0);
    expect((await run(home, ["whoami"])).code).toBe(3);
  });

  it("logout removes only its profile; --all deletes the file", async () => {
    await login();
    await login(["--profile", "two"]);
    await run(home, ["logout", "--profile", "two"]);
    expect(Object.keys(JSON.parse(readFileSync(cred(), "utf8")).profiles)).toEqual(["default"]);
    await login(["--profile", "two"]);
    await run(home, ["logout", "--all"]);
    expect(existsSync(cred())).toBe(false);
  });

  it("whoami asks the API every time and never prints the full token", async () => {
    await login();
    server.reply = () => ({ status: 401, body: err("invalid_token") });
    expect((await run(home, ["whoami"])).code).toBe(3);
    server.reply = () => ({ status: 200, body: fixture("getAccount", "200-ok.json") });
    const res = await run(home, ["whoami"]);
    expect(res.stdout).toContain("plan: starter");
    expect(res.stdout).not.toContain(token);
    expect(server.seen).toHaveLength(2);
  });

  it("profiles lists name and origin", async () => {
    await login(["--profile", "staging"]);
    expect((await run(home, ["profiles"])).stdout).toContain(`staging (${server.origin})`);
  });
});
