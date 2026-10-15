import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkFile, getCredential, readCredentials } from "../src/credentials.js";
import { stripControl } from "../src/scrub.js";
import { MAX_BODY_BYTES } from "../src/transport.js";
import { err, fixture, FixtureServer, newToken, run, tempHome } from "./helpers.js";

const server = new FixtureServer();
const other = new FixtureServer();
const token = newToken();
let home: string;
let dir: string;
beforeAll(async () => void (await Promise.all([server.start(), other.start()])));
afterAll(() => Promise.all([server.stop(), other.stop()]));
beforeEach(() => {
  server.seen = [];
  other.seen = [];
  server.reply = () => ({ status: 200, body: fixture("getAccount", "200-ok.json") });
  other.reply = () => ({ status: 200, body: fixture("getAccount", "200-ok.json") });
  home = tempHome();
  dir = path.join(home, ".config", "fulcrumaxe");
});

describe("inherited object keys are never credentials", () => {
  const names = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "prototype"];

  it.each(names)("whoami and logout refuse the profile name %s with exit 2 and no 'undefined' on screen", async (name) => {
    await run(home, ["login", "--base-url", server.origin], { stdin: `${token}\n` });
    server.seen = [];
    for (const argv of [["--profile", name, "whoami"], ["logout", "--profile", name]]) {
      const res = await run(home, argv, { env: {} });
      expect(res.code).toBe(2);
      expect(res.stdout + res.stderr).not.toContain("undefined");
    }
    expect(server.seen.length).toBe(0);
  });

  it.each(names)("FX_PROFILE=%s is refused the same way", async (name) => {
    const res = await run(home, ["whoami"], { env: { FX_PROFILE: name, FX_TOKEN: token, FX_BASE_URL: server.origin } });
    expect(res.code).toBe(2);
    expect(server.seen.length).toBe(0);
  });

  it("a credential file with such keys yields no credential for them, and the saved login still works", () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const rec = { origin: server.origin, token, saved_at: "t" };
    writeFileSync(path.join(dir, "credentials.json"), `{"v":1,"profiles":{"__proto__":${JSON.stringify(rec)},"default":${JSON.stringify(rec)}}}`, { mode: 0o600 });
    const creds = readCredentials({ env: { XDG_CONFIG_HOME: path.join(home, ".config") }, home, uid: process.getuid?.() } as never);
    expect(Object.getPrototypeOf(creds)).toBeNull();
    for (const name of ["constructor", "toString", "hasOwnProperty", "valueOf"]) expect(getCredential(creds, name)).toBeUndefined();
    expect(getCredential(creds, "default")?.token).toBe(token);
  });
});

describe("FX_TOKEN and an unchecked config.json", () => {
  const point = (): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ profiles: { default: other.origin } }));
  };

  it("sends nothing and exits 3 when config.json would supply the origin but its directory is open to others", async () => {
    point();
    chmodSync(dir, 0o777);
    const res = await run(home, ["whoami"], { env: { FX_TOKEN: token } });
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("not safe to use");
    expect(other.seen.length + server.seen.length).toBe(0);
  });

  it("uses the configured origin when the directory is private", async () => {
    point();
    chmodSync(dir, 0o700);
    const res = await run(home, ["whoami"], { env: { FX_TOKEN: token } });
    expect(res.code).toBe(0);
    expect(other.seen.length).toBe(1);
  });

  it("FX_BASE_URL needs no config.json, so an open directory does not matter", async () => {
    point();
    chmodSync(dir, 0o777);
    const res = await run(home, ["whoami"], { env: { FX_TOKEN: token, FX_BASE_URL: server.origin } });
    expect(res.code).toBe(0);
    expect(other.seen.length).toBe(0);
  });
});

describe("hostile server", () => {
  it("drops a response body larger than the cap with exit 1 and a fixed message", async () => {
    server.reply = () => ({ status: 200, body: "x".repeat(MAX_BODY_BYTES + 1) });
    const res = await run(home, ["whoami"], { env: { FX_TOKEN: token, FX_BASE_URL: server.origin } });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("larger than");
  });

  it("strips terminal escape sequences from the API's message and from plan/status", async () => {
    server.reply = () => ({ status: 404, body: err("not_found", "gone\u001b[2J\u001b]0;pwned\u0007\r\u009b31m") });
    const bad = await run(home, ["whoami"], { env: { FX_TOKEN: token, FX_BASE_URL: server.origin } });
    expect(bad.code).toBe(4);
    expect(bad.stderr).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(bad.stderr).toContain("gone");
    const account = JSON.parse(fixture("getAccount", "200-ok.json")) as Record<string, unknown>;
    server.reply = () => ({ status: 200, body: JSON.stringify({ ...account, plan: "pro\u001b[31m", status: "act\u0007ive\u0085" }) });
    const ok = await run(home, ["whoami"], { env: { FX_TOKEN: token, FX_BASE_URL: server.origin } });
    expect(ok.code).toBe(0);
    expect(ok.stdout).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });

  it("stripControl keeps newline and tab", () => {
    expect(stripControl("a\nb\tc\u001b[0m")).toBe("a\nb\tc[0m");
  });
});

describe("checkFile", () => {
  const info = (o: Record<string, unknown>) => ({ isSymbolicLink: () => false, isFile: () => true, nlink: 1, uid: 1000, mode: 0o100600, ...o }) as never;
  it("refuses a file owned by another user, on its own (the directory check is not involved)", () => {
    expect(() => checkFile(info({}), 1001)).toThrow(/belongs to another user/);
    expect(() => checkFile(info({}), 1000)).not.toThrow();
    expect(() => checkFile(info({}), undefined)).not.toThrow();
  });
});
