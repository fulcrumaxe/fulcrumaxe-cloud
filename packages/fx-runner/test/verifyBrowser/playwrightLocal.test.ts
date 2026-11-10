import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseEnvelope } from "../../../pipeline/src/verify/envelope.js";
import { BROWSER_PLAYWRIGHT_CAPABILITY, DEPLOY_VERIFIER_DENIED_BROWSER_TOOLS, DEPLOY_VERIFIER_PLAYWRIGHT_BROWSER_TOOLS, DEPLOY_VERIFIER_ROLE, type BrowserMethod } from "@fulcrumaxe/runner-protocol";
import { runCli } from "../../src/cli.js";
import { verifyLoginCommand, type VerifyLoginHost } from "../../src/commands/verifyLogin.js";
import { serverOptionsFrom } from "../../src/commands/verifyBrowserServer.js";
import { readVerifyAnswer, withAnswerFile } from "../../src/daemon/answerFile.js";
import { probePlaywright, type PlaywrightProbeReason } from "../../src/daemon/playwrightProbe.js";
import { createVerifyLocal } from "../../src/daemon/verifyLocal.js";
import { chromeFlagFor, claudeArgv } from "../../src/engines/claude/argv.js";
import { outcomeOf } from "../../src/engines/claude/engine.js";
import { clearVerifyLeftovers, mcpConfigFor, settingsFor, writeJobFiles, type VerifyServerSpec } from "../../src/engines/claude/settingsFile.js";
import { confineFileTools } from "../../src/engines/claude/filePermissions.js";
import { roleToolsFor } from "../../src/job/roleTools.js";
import { loadSettings, parseBaseUrlSetting, setSetting, unsetSetting } from "../../src/runnerSettings.js";
import { protectedPaths } from "../../src/sandbox/sandboxSettings.js";
import { APP_SESSION_COOKIE } from "../../src/verifyBrowser/stateScope.js";
import { RUN_ID, engineFor, makeRig } from "../engines/claude/rig.js";
import { filesUnder, PACKAGE_DIR } from "../helpers/srcFiles.js";
import { tmpRoot } from "../helpers/tmpRoot.js";

/**
 * D#749 V2c-2b: the runner's local wiring of the playwright deploy check: the settings and MCP file per method and role, the engine's command line, the probe and the capability, the
 * browser settings, `verify-login`, the answer file, and the production wiring's one hard rule (no certificate bypass).
 */
const UID = process.getuid?.() ?? 0;
const root = mkdtempSync(path.join(tmpRoot(), "pw-local-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SANDBOX = { enabled: true, filesystem: { denyRead: ["~"] } };
const SERVER: VerifyServerSpec = { command: "/opt/fx/fx-runner", args: ["--flag-of-the-self-command"], baseUrl: "https://app.example.test/", executable: "/opt/chrome/chromium", storageState: "/h/.config/fx-runner/verify/storage-state.json" };
const protectedList = protectedPaths({ home: path.join(root, "home"), stateDir: path.join(root, "home", ".fx-runner"), binaryDir: path.join(root, "bin") });

describe("the MCP file and the command line, per method and role", () => {
  it("only the deploy verifier with the playwright method gets the fxverify entry; every other role and method gets none", () => {
    const entry = mcpConfigFor({ role: DEPLOY_VERIFIER_ROLE, browserMethod: "playwright_runner" }, "/state/jobs/run1", SERVER);
    expect(entry).toEqual({
      mcpServers: {
        fxverify: {
          type: "stdio",
          command: "/opt/fx/fx-runner",
          args: ["--flag-of-the-self-command", "verify-browser-server", "--job-dir", "/state/jobs/run1", "--base-url", "https://app.example.test/", "--executable", "/opt/chrome/chromium", "--storage-state", "/h/.config/fx-runner/verify/storage-state.json"],
          env: {},
        },
      },
    });
    const none = { mcpServers: {} };
    for (const method of [undefined, "chrome_runner"] as Array<BrowserMethod | undefined>) expect(mcpConfigFor({ role: DEPLOY_VERIFIER_ROLE, browserMethod: method }, "/j", SERVER)).toEqual(none);
    for (const role of ["executor", "code-reviewer", "security-reviewer", "proposal-verifier", "project-manager"]) {
      for (const method of [undefined, "chrome_runner", "playwright_runner"] as Array<BrowserMethod | undefined>) expect(mcpConfigFor({ role, browserMethod: method }, "/j", SERVER), `${role} ${String(method)}`).toEqual(none);
    }
  });

  it("a playwright deploy verifier with no server to start is refused, never given an empty file", () => {
    expect(() => mcpConfigFor({ role: DEPLOY_VERIFIER_ROLE, browserMethod: "playwright_runner" }, "/j")).toThrow(/not configured/);
  });

  it("the entry carries no credential and no token in its arguments or its environment", () => {
    const text = JSON.stringify(mcpConfigFor({ role: DEPLOY_VERIFIER_ROLE, browserMethod: "playwright_runner" }, "/j", SERVER));
    expect(text).not.toMatch(/token|secret|api[_-]?key|password|cookie/i);
  });

  it("the chrome flag is for the Chrome method alone: a playwright job carries --no-chrome and never --chrome", () => {
    expect(chromeFlagFor(DEPLOY_VERIFIER_ROLE, undefined)).toBe(true);
    expect(chromeFlagFor(DEPLOY_VERIFIER_ROLE, "chrome_runner")).toBe(true);
    expect(chromeFlagFor(DEPLOY_VERIFIER_ROLE, "playwright_runner")).toBe(false);
    expect(chromeFlagFor("executor", "playwright_runner")).toBe(false);
    const tools = roleToolsFor(DEPLOY_VERIFIER_ROLE, "playwright_runner");
    const argv = claudeArgv({ cliModel: "sonnet", roleTools: tools, allowRules: confineFileTools(tools, "/ws"), settingsPath: "/s", mcpPath: "/m", chrome: chromeFlagFor(DEPLOY_VERIFIER_ROLE, "playwright_runner") });
    expect(argv).toContain("--no-chrome");
    expect(argv).not.toContain("--chrome");
    expect(argv).toContain("--strict-mcp-config");
    // The CLI's built-in tools are the three reads; the twelve fxverify tools are granted by their allow rules alone.
    expect(argv[argv.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
    const allowed = argv.slice(argv.indexOf("--allowedTools") + 1, argv.indexOf("--disallowedTools"));
    expect(allowed).toEqual(expect.arrayContaining([...DEPLOY_VERIFIER_PLAYWRIGHT_BROWSER_TOOLS]));
  });

  it("the playwright job's settings allow the confined reads and the twelve fxverify tools, and still deny the five Chrome extension tools", () => {
    const ws = path.join(root, "ws");
    const s = settingsFor(DEPLOY_VERIFIER_ROLE, SANDBOX, ws, protectedList, [], undefined, undefined, "playwright_runner") as { permissions: { allow: string[]; deny: string[] } };
    expect(s.permissions.allow).toEqual([`Read(/${ws})`, `Read(/${ws}/**)`, ...DEPLOY_VERIFIER_PLAYWRIGHT_BROWSER_TOOLS]);
    expect(s.permissions.allow.join(" ")).not.toMatch(/claude-in-chrome|Bash|Edit|Write/);
    expect(s.permissions.deny).toEqual(expect.arrayContaining([...DEPLOY_VERIFIER_DENIED_BROWSER_TOOLS]));
  });

  it("writeJobFiles puts the entry in mcp.json (0600) for a playwright job and an empty file for the Chrome job", () => {
    const ws = path.join(root, "ws2");
    mkdirSync(ws, { recursive: true });
    const jobDir = path.join(root, "job-pw");
    const files = writeJobFiles(jobDir, ws, DEPLOY_VERIFIER_ROLE, SANDBOX, protectedList, [], undefined, undefined, { browserMethod: "playwright_runner", verifyServer: SERVER });
    const mcp = JSON.parse(readFileSync(files.mcpPath, "utf8")) as { mcpServers: Record<string, { args: string[] }> };
    expect(Object.keys(mcp.mcpServers)).toEqual(["fxverify"]);
    expect(mcp.mcpServers["fxverify"]!.args).toContain(jobDir);
    expect(statSync(files.mcpPath).mode & 0o777).toBe(0o600);
    const chrome = writeJobFiles(path.join(root, "job-chrome"), ws, DEPLOY_VERIFIER_ROLE, SANDBOX, protectedList, [], undefined, undefined, { browserMethod: "chrome_runner" });
    expect(JSON.parse(readFileSync(chrome.mcpPath, "utf8"))).toEqual({ mcpServers: {} });
  });
});

describe("the engine really spawns the playwright job as designed", () => {
  const start = async (method: BrowserMethod | undefined, spec: VerifyServerSpec | undefined = SERVER) => {
    const rig = makeRig();
    rig.config.verifyServer = spec === undefined ? undefined : () => spec;
    const engine = engineFor(rig);
    const opts = { ...rig.startOptions({ role: DEPLOY_VERIFIER_ROLE }), ...(method === undefined ? {} : { browserMethod: method }) };
    const first = await engine.start(opts);
    await outcomeOf(first.handle);
    return { rig, engine, first, argv: rig.fake.argv() };
  };

  it("a playwright start: --no-chrome, the strict MCP file with the fxverify entry, the fxverify allow rules; the same on a resume", async () => {
    const { rig, engine, first, argv } = await start("playwright_runner");
    const resumed = await engine.resume(first.handle, "sess-0001", "next");
    await outcomeOf(resumed.handle);
    for (const a of [argv, rig.fake.argv()]) {
      expect(a).toContain("--no-chrome");
      expect(a).not.toContain("--chrome");
      expect(a).toContain("--strict-mcp-config");
      expect(a).toContain("mcp__fxverify__submit_answer");
    }
    const mcpFile = argv[argv.indexOf("--mcp-config") + 1]!;
    expect(Object.keys((JSON.parse(readFileSync(mcpFile, "utf8")) as { mcpServers: object }).mcpServers)).toEqual(["fxverify"]);
  });

  it("a Chrome start keeps --chrome and an empty MCP file; a start with no method is the Chrome one", async () => {
    for (const method of ["chrome_runner", undefined] as const) {
      const { argv } = await start(method);
      expect(argv).toContain("--chrome");
      expect(argv).not.toContain("--no-chrome");
      expect(argv.join(" ")).not.toContain("mcp__fxverify__");
      expect(JSON.parse(readFileSync(argv[argv.indexOf("--mcp-config") + 1]!, "utf8"))).toEqual({ mcpServers: {} });
    }
  });

  it("a playwright start with no server configured is refused before anything is spawned", async () => {
    const rig = makeRig();
    const engine = engineFor(rig);
    await expect(engine.start({ ...rig.startOptions({ role: DEPLOY_VERIFIER_ROLE }), browserMethod: "playwright_runner" } as never)).rejects.toMatchObject({ code: "bad_start_options" });
    // only the binary's version, flag and login questions were asked; the agent itself never ran (it would have read a prompt)
    expect(existsSync(path.join(rig.fake.dir, "stdin.txt"))).toBe(false);
    expect(existsSync(path.join(rig.config.jobsDir, RUN_ID, "mcp.json"))).toBe(false);
  });

  it("the engine clears the last attempt's answer and browser folders when a run id is started again; a Chrome start leaves them alone", async () => {
    for (const [method, cleared] of [["playwright_runner", true], ["chrome_runner", false]] as const) {
      const rig = makeRig();
      rig.config.verifyServer = () => SERVER;
      const jobDir = path.join(rig.config.jobsDir, RUN_ID);
      for (const sub of ["home/x", "tmp/y"]) mkdirSync(path.join(jobDir, sub), { recursive: true });
      writeFileSync(path.join(jobDir, "answer.json"), '{"journeys":[]}');
      await outcomeOf((await engineFor(rig).start({ ...rig.startOptions({ role: DEPLOY_VERIFIER_ROLE }), browserMethod: method } as never)).handle);
      expect(["answer.json", "home", "tmp"].filter((n) => existsSync(path.join(jobDir, n))), method).toEqual(cleared ? [] : ["answer.json", "home", "tmp"]);
    }
  });

  it("a re-claimed run id does not read the last attempt's answer or trip over its browser folders", () => {
    const dir = path.join(root, "job-left");
    for (const sub of ["home/x", "tmp/y"]) mkdirSync(path.join(dir, sub), { recursive: true });
    writeFileSync(path.join(dir, "answer.json"), "{}");
    clearVerifyLeftovers(dir);
    expect(["answer.json", "home", "tmp"].filter((n) => existsSync(path.join(dir, n)))).toEqual([]);
  });
});

describe("the browser settings", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(path.join(root, "state-"));
  });

  it("are set, read back, and cleared one by one; a value that is not a plain absolute path or a safe address is refused and nothing is written", () => {
    setSetting(stateDir, "verify.browser.executable", "/opt/chrome/chromium");
    setSetting(stateDir, "verify.browser.storage_state", "/h/.config/fx-runner/verify/s.json");
    setSetting(stateDir, "verify.browser.base_url", "https://app.example.test");
    expect(loadSettings(stateDir).verify?.browser).toEqual({ executable: "/opt/chrome/chromium", storageState: "/h/.config/fx-runner/verify/s.json", baseUrl: "https://app.example.test/" });
    for (const [key, bad] of [["verify.browser.executable", "chromium"], ["verify.browser.executable", "/a/../b"], ["verify.browser.storage_state", "relative.json"], ["verify.browser.base_url", "http://app.example.test"], ["verify.browser.base_url", "https://u:p@app.example.test"], ["verify.browser.base_url", "https://app.example.test/?x=1"]] as const) {
      expect(() => setSetting(stateDir, key, bad), `${key} ${bad}`).toThrow();
    }
    unsetSetting(stateDir, "verify.browser.storage_state");
    expect(loadSettings(stateDir).verify?.browser).toEqual({ executable: "/opt/chrome/chromium", baseUrl: "https://app.example.test/" });
    unsetSetting(stateDir, "verify.browser.executable");
    unsetSetting(stateDir, "verify.browser.base_url");
    expect(loadSettings(stateDir).verify).toBeUndefined();
    expect(statSync(path.join(stateDir, "runner-settings.json")).mode & 0o777).toBe(0o600);
  });

  it("a base URL is https, or http on a loopback host only", () => {
    expect(parseBaseUrlSetting("https://app.example.test")).toBe("https://app.example.test/");
    expect(parseBaseUrlSetting("http://localhost:3000")).toBe("http://localhost:3000/");
    expect(parseBaseUrlSetting("http://app.example.test")).toBeUndefined();
    expect(parseBaseUrlSetting("javascript:alert(1)")).toBeUndefined();
  });
});

/** A machine that passes the probe, in a directory of its own; each test breaks one thing. */
function machine(label: string) {
  const home = mkdtempSync(path.join(root, `${label}-`));
  const stateDir = path.join(home, ".fx-runner");
  mkdirSync(stateDir, { mode: 0o700 });
  const exe = path.join(home, "chromium");
  writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
  const dir = path.join(home, ".config", "fx-runner", "verify");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const state = path.join(dir, "storage-state.json");
  const cookie = (over: Record<string, unknown> = {}) => ({ name: APP_SESSION_COOKIE, value: "S3CR3T-COOKIE", domain: "app.example.test", path: "/", expires: Date.now() / 1000 + 3600, httpOnly: true, secure: true, sameSite: "Lax", ...over });
  const writeState = (cookies: unknown[] = [cookie()], mode = 0o600) => {
    writeFileSync(state, JSON.stringify({ cookies, origins: [] }), { mode });
    chmodSync(state, mode);
  };
  writeState();
  setSetting(stateDir, "verify.test_account", "fx-test-user");
  setSetting(stateDir, "verify.browser.base_url", "https://app.example.test");
  setSetting(stateDir, "verify.browser.executable", exe);
  const probe = (over: { playwright?: boolean; now?: number } = {}) =>
    probePlaywright({ settings: () => loadSettings(stateDir).verify, home, uid: UID, now: () => over.now ?? Date.now(), playwrightAvailable: () => over.playwright ?? true });
  return { home, stateDir, exe, state, cookie, writeState, probe };
}

describe("the playwright probe", () => {
  it("passes when the executable, the storage state, the test account and the base URL are all there", () => {
    expect(machine("ok").probe()).toEqual({ ok: true });
  });

  const failures: Array<[PlaywrightProbeReason, (m: ReturnType<typeof machine>) => ReturnType<ReturnType<typeof machine>["probe"]>]> = [
    ["test_account_missing", (m) => (unsetSetting(m.stateDir, "verify.test_account"), m.probe())],
    ["base_url_missing", (m) => (unsetSetting(m.stateDir, "verify.browser.base_url"), m.probe())],
    ["executable_missing", (m) => (rmSync(m.exe), m.probe())],
    ["executable_missing", (m) => (unsetSetting(m.stateDir, "verify.browser.executable"), m.probe())],
    ["executable_not_runnable", (m) => (chmodSync(m.exe, 0o644), m.probe())],
    ["executable_not_chromium", (m) => (setSetting(m.stateDir, "verify.browser.executable", (writeFileSync(path.join(m.home, "firefox"), "#!/bin/sh\n", { mode: 0o755 }), path.join(m.home, "firefox"))), m.probe())],
    ["playwright_missing", (m) => m.probe({ playwright: false })],
    ["storage_state_missing", (m) => (rmSync(m.state), m.probe())],
    ["storage_state_unsafe", (m) => (m.writeState([m.cookie()], 0o640), m.probe())],
    ["storage_state_unsafe", (m) => (m.writeState([m.cookie()], 0o644), m.probe())],
    ["storage_state_unsafe", (m) => (rmSync(m.state), symlinkSync(path.join(m.home, "chromium"), m.state), m.probe())],
    ["storage_state_outside_floor", (m) => (writeFileSync(path.join(m.home, "state.json"), JSON.stringify({ cookies: [m.cookie()] }), { mode: 0o600 }), setSetting(m.stateDir, "verify.browser.storage_state", path.join(m.home, "state.json")), m.probe())],
    ["storage_state_unreadable", (m) => (writeFileSync(m.state, "not json", { mode: 0o600 }), m.probe())],
    ["storage_state_foreign", (m) => (m.writeState([m.cookie({ domain: "other.example.test" })]), m.probe())],
    ["storage_state_foreign", (m) => (m.writeState([m.cookie(), m.cookie({ name: "user_session", domain: ".github.com" })]), m.probe())],
    ["storage_state_foreign", (m) => (m.writeState([m.cookie({ domain: ".example.test" })]), m.probe())],
    ["storage_state_foreign", (m) => (writeFileSync(m.state, JSON.stringify({ cookies: [m.cookie()], origins: [{ origin: "https://github.com", localStorage: [] }] }), { mode: 0o600 }), m.probe())],
    ["storage_state_no_session", (m) => (m.writeState([m.cookie({ name: "_ga", value: "analytics" })]), m.probe())],
    ["storage_state_expired", (m) => (m.writeState([m.cookie({ expires: Date.now() / 1000 - 60 })]), m.probe())],
    // an expired session cookie next to a live analytics cookie of the same host is still expired
    ["storage_state_expired", (m) => (m.writeState([m.cookie({ expires: Date.now() / 1000 - 60 }), m.cookie({ name: "_ga", value: "analytics", expires: Date.now() / 1000 + 3600 })]), m.probe())],
  ];
  it.each(failures)("fails with the named code %s", (reason, break_) => {
    expect(break_(machine(reason))).toEqual({ ok: false, reason });
  });

  it("another user's file fails; a session cookie (expires -1), alone or beside other cookies of the host, counts as a session", () => {
    const m = machine("owner");
    expect(probePlaywright({ settings: () => loadSettings(m.stateDir).verify, home: m.home, uid: UID + 1, now: Date.now, playwrightAvailable: () => true })).toEqual({ ok: false, reason: "storage_state_unsafe" });
    m.writeState([m.cookie({ expires: -1 })]);
    expect(m.probe()).toEqual({ ok: true });
    m.writeState([m.cookie(), m.cookie({ name: "_ga", expires: Date.now() / 1000 - 60 }), m.cookie({ domain: ".app.example.test", name: "pref" })]);
    expect(m.probe()).toEqual({ ok: true });
    m.writeState([m.cookie({ domain: "notexample.test" })]);
    expect(m.probe()).toEqual({ ok: false, reason: "storage_state_foreign" });
  });

  it("a session cookie that is not the app's own signed one (another name) never counts", () => {
    const m = machine("name");
    m.writeState([m.cookie({ name: "session" })]);
    expect(m.probe()).toEqual({ ok: false, reason: "storage_state_no_session" });
  });

  it("the cookie name is the one the app really sets (packages/core/src/auth/session.ts)", () => {
    const core = readFileSync(path.join(PACKAGE_DIR, "..", "core", "src", "auth", "session.ts"), "utf8");
    expect(core).toContain(`export const SESSION_COOKIE_NAME = '${APP_SESSION_COOKIE}';`);
  });

  it("the default storage-state path is the one under the credential floor, and the failure never carries the file's content", () => {
    const m = machine("secret");
    m.writeState([m.cookie({ expires: Date.now() / 1000 - 60 })]);
    expect(JSON.stringify(m.probe())).not.toContain("S3CR3T");
  });
});

describe("the capability and the claim check", () => {
  const local = (m: ReturnType<typeof machine>, over: { selfCommand?: string[] | undefined; playwright?: boolean } = {}) =>
    createVerifyLocal({ stateDir: m.stateDir, uid: UID, username: "tester", env: {}, platform: "linux", home: m.home, selfCommand: "selfCommand" in over ? over.selfCommand : ["/opt/fx/fx-runner"], playwrightProbe: { playwrightAvailable: () => over.playwright ?? true } });

  it("browser_playwright_v1 is advertised only when the probe passes, and the claim check answers the closed code when it fails", async () => {
    const m = machine("cap");
    expect(await local(m).capabilities()).toEqual([BROWSER_PLAYWRIGHT_CAPABILITY]);
    expect(await local(m).browserReady("playwright_runner")).toBeUndefined();
    rmSync(m.state);
    expect(await local(m).capabilities()).toEqual([]);
    expect(await local(m).browserReady("playwright_runner")).toBe("browser_not_connected");
    expect(local(m).probePlaywright()).toEqual({ ok: false, reason: "storage_state_missing" });
  });

  it("no program command to run, or no loadable library, means no capability; a cloud that refused it is not offered it again", async () => {
    const m = machine("cap2");
    expect(await local(m, { selfCommand: undefined }).capabilities()).toEqual([]);
    expect(await local(m, { playwright: false }).capabilities()).toEqual([]);
    const v = local(m);
    v.refuse([BROWSER_PLAYWRIGHT_CAPABILITY]);
    expect(await v.capabilities()).toEqual([]);
  });

  it("the Chrome claim check is unchanged by a good playwright setup (the two methods are checked apart)", async () => {
    const m = machine("cap3");
    expect(await local(m).browserReady()).toBe("browser_not_connected");
    expect(await local(m).browserReady("chrome_runner")).toBe("browser_not_connected");
  });

  it("verifyServer() is the program's own command and the owner's three settings, with the default storage-state path", () => {
    const m = machine("srv");
    expect(local(m, { selfCommand: ["/opt/fx/fx-runner", "--x"] }).verifyServer()).toEqual({ command: "/opt/fx/fx-runner", args: ["--x"], baseUrl: "https://app.example.test/", executable: m.exe, storageState: m.state });
    unsetSetting(m.stateDir, "verify.browser.executable");
    expect(local(m).verifyServer()).toBeUndefined();
  });
});

describe("fx-runner verify-login", () => {
  const STATE = { cookies: [{ name: APP_SESSION_COOKIE, value: "LOGIN-SECRET-VALUE", domain: "app.example.test", path: "/", expires: 1893456000, httpOnly: true, secure: true, sameSite: "Lax" }], origins: [{ origin: "https://app.example.test", localStorage: [{ name: "token", value: "LS-SECRET" }] }] };
  const rig = (state: unknown = STATE, pageUrl?: string) => {
    const m = machine("login");
    rmSync(m.state);
    const out: string[] = [];
    const calls: string[] = [];
    const host: VerifyLoginHost = {
      home: m.home,
      interactive: true,
      findHeaded: () => m.exe,
      openHeaded: async (exe, url) => {
        calls.push(`open ${path.basename(exe)} ${url}`);
        return { storageState: async () => state, ...(pageUrl === undefined ? {} : { currentUrl: () => pageUrl }), close: async () => void calls.push("close") };
      },
      waitForEnter: async () => void calls.push("enter"),
    };
    const ctx = { stateDir: m.stateDir, out: (l: string) => void out.push(l), err: (l: string) => void out.push(l), now: () => new Date(), fetchFn: fetch };
    return { m, host, ctx, out, calls, run: (url: string) => verifyLoginCommand(new Map([["base-url", url]]), ctx, host) };
  };

  it("opens a headed browser on the app, waits for Enter, then saves the state at 0600 in a 0700 folder and sets the address; the probe then passes", async () => {
    const { m, run, calls } = rig();
    expect(await run("https://app.example.test")).toBe(0);
    expect(calls).toEqual(["open chromium https://app.example.test/", "enter", "close"]);
    expect(statSync(m.state).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(m.state)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(m.state, "utf8"))).toEqual(STATE);
    expect(loadSettings(m.stateDir).verify?.browser?.baseUrl).toBe("https://app.example.test/");
    expect(m.probe({ now: Date.now() })).toEqual({ ok: true });
  });

  it("never prints the state: nothing from the cookies or the page storage is in any output line or in the settings file", async () => {
    const { m, run, out } = rig();
    await run("https://app.example.test");
    const shown = out.join("\n");
    for (const secret of ["LOGIN-SECRET-VALUE", "LS-SECRET", APP_SESSION_COOKIE, "token"]) expect(shown).not.toContain(secret);
    expect(shown).toContain("2030-01-01");
    expect(readFileSync(path.join(m.stateDir, "runner-settings.json"), "utf8")).not.toContain("SECRET");
  });

  it("saves only the app's own origin: a github.com cookie, a parent-domain cookie and another origin's page storage are never written", async () => {
    const dirty = {
      cookies: [...STATE.cookies, { name: "user_session", value: "GH-SECRET-COOKIE", domain: ".github.com", path: "/", expires: 1893456000 }, { name: "_ga", value: "PARENT-COOKIE", domain: ".example.test", path: "/", expires: -1 }],
      origins: [...STATE.origins, { origin: "https://github.com", localStorage: [{ name: "gh", value: "GH-LS-SECRET" }] }],
    };
    const { m, run } = rig(dirty);
    expect(await run("https://app.example.test")).toBe(0);
    const text = readFileSync(m.state, "utf8");
    for (const never of ["GH-SECRET-COOKIE", "GH-LS-SECRET", "github.com", "PARENT-COOKIE"]) expect(text).not.toContain(never);
    expect(JSON.parse(text)).toEqual(STATE);
    expect(m.probe({ now: Date.now() })).toEqual({ ok: true });
  });

  it("saves nothing when only another origin's session is left after the cut", async () => {
    const onlyGithub = rig({ cookies: [{ name: "user_session", value: "GH-SECRET-COOKIE", domain: ".github.com", expires: 1893456000 }, { name: "other", value: "v", domain: "app.example.test", expires: -1 }], origins: [] });
    await expect(onlyGithub.run("https://app.example.test")).rejects.toThrow(/nothing was saved/);
    expect(existsSync(onlyGithub.m.state)).toBe(false);
  });

  describe("--forget, the way back", () => {
    const forget = (r: ReturnType<typeof rig>) => verifyLoginCommand(new Map<string, string | true>([["forget", true]]), r.ctx, r.host);

    it("deletes the saved state, says so, and a second run says there was nothing; config unset alone leaves the file in place", async () => {
      const r = rig();
      r.m.writeState();
      unsetSetting(r.m.stateDir, "verify.browser.base_url");
      unsetSetting(r.m.stateDir, "verify.browser.executable");
      expect(existsSync(r.m.state)).toBe(true);
      expect(await forget(r)).toBe(0);
      expect(existsSync(r.m.state)).toBe(false);
      expect(r.out.join("\n")).toContain("deleted");
      expect(r.calls).toEqual([]);
      expect(await forget(r)).toBe(0);
      expect(r.out.at(-1)).toContain("nothing to delete");
    });

    it("removes a planted link itself and never touches what it points at", async () => {
      const r = rig();
      const target = path.join(r.m.home, "precious.txt");
      writeFileSync(target, "keep me");
      symlinkSync(target, r.m.state);
      expect(await forget(r)).toBe(0);
      expect(existsSync(r.m.state) || (() => { try { return lstatSync(r.m.state).isSymbolicLink(); } catch { return false; } })()).toBe(false);
      expect(readFileSync(target, "utf8")).toBe("keep me");
    });

    it("does not touch a storage-state file set outside the credential floor, and takes no other option", async () => {
      const r = rig();
      const outside = path.join(r.m.home, "plain.json");
      writeFileSync(outside, "{}");
      setSetting(r.m.stateDir, "verify.browser.storage_state", outside);
      await expect(forget(r)).rejects.toMatchObject({ exitCode: 2 });
      expect(existsSync(outside)).toBe(true);
      await expect(verifyLoginCommand(new Map<string, string | true>([["forget", true], ["base-url", "https://app.example.test"]]), r.ctx, r.host)).rejects.toMatchObject({ exitCode: 2 });
    });

    it("is on the command line", async () => {
      const r = rig();
      r.m.writeState();
      const io = { argv: ["verify-login", "--forget"], home: root, stateDirOverride: r.m.stateDir, stdout: () => undefined, stderr: () => undefined, verifyLoginHost: r.host };
      expect(await runCli(io)).toBe(0);
      expect(existsSync(r.m.state)).toBe(false);
    });
  });

  it("refuses an address that is not https (localhost excepted) before any browser opens", async () => {
    for (const url of ["http://app.example.test", "ftp://app.example.test", "file:///etc/passwd", "javascript:1", "app.example.test", "https://user:pw@app.example.test"]) {
      const { run, calls, m } = rig();
      await expect(run(url), url).rejects.toMatchObject({ exitCode: 2 });
      expect(calls, url).toEqual([]);
      expect(existsSync(m.state), url).toBe(false);
    }
    const { run, calls } = rig({ cookies: [{ name: APP_SESSION_COOKIE, value: "v", domain: "localhost", expires: -1 }] });
    expect(await run("http://localhost:3000")).toBe(0);
    expect(calls[0]).toBe("open chromium http://localhost:3000/");
  });

  it("saves nothing when the browser holds no session for the address, and closes the browser when the wait fails", async () => {
    const empty = rig({ cookies: [{ name: "s", value: "v", domain: "elsewhere.test", expires: -1 }] });
    await expect(empty.run("https://app.example.test")).rejects.toThrow(/nothing was saved/);
    expect(existsSync(empty.m.state)).toBe(false);
    const broken = rig();
    broken.host.waitForEnter = async () => {
      throw new Error("terminal closed");
    };
    await expect(broken.run("https://app.example.test")).rejects.toThrow("terminal closed");
    expect(broken.calls).toContain("close");
    expect(existsSync(broken.m.state)).toBe(false);
  });

  describe("a terminal is required", () => {
    it("refuses at once without a terminal: no browser opens, nothing is waited for, nothing is saved", async () => {
      const r = rig();
      r.host.interactive = false;
      await expect(r.run("https://app.example.test")).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining("run this in a terminal: it waits for you to press Enter after signing in") });
      expect(r.calls).toEqual([]);
      expect(existsSync(r.m.state)).toBe(false);
    });

    it("treats end of input as an abort with a message, closes the browser, and saves nothing", async () => {
      const r = rig();
      r.host.waitForEnter = async () => {
        r.calls.push("enter");
        return "eof";
      };
      await expect(r.run("https://app.example.test")).rejects.toMatchObject({ exitCode: 1, message: expect.stringContaining("standard input closed before you pressed Enter") });
      expect(r.calls).toEqual(["open chromium https://app.example.test/", "enter", "close"]);
      expect(existsSync(r.m.state)).toBe(false);
    });

    it("with a terminal it still works end to end", async () => {
      const r = rig();
      expect(r.host.interactive).toBe(true);
      expect(await r.run("https://app.example.test")).toBe(0);
      expect(existsSync(r.m.state)).toBe(true);
    });

    it("the program's own host: no terminal on standard input means interactive is false", () => {
      const text = readFileSync(path.join(import.meta.dirname, "../../bin/fx-runner.mjs"), "utf8");
      const block = text.slice(text.indexOf("verifyLoginHost"), text.indexOf("serviceHost"));
      expect(block).toContain("interactive: process.stdin.isTTY === true");
      expect(block).toContain('process.stdin.once("end", onEnd)');
    });
  });

  describe("a sign-in the app moved to its canonical address", () => {
    const CANON = "https://canonical.example.test";
    const canonState = { cookies: [{ name: APP_SESSION_COOKIE, value: "CANON-SECRET-VALUE", domain: "canonical.example.test", path: "/", expires: 1893456000 }, { name: "other", value: "v", domain: "app.example.test", expires: -1 }], origins: [{ origin: CANON, localStorage: [{ name: "t", value: "CANON-LS" }] }] };

    it("names the origin to use, saves nothing and never prints the state", async () => {
      const r = rig(canonState, `${CANON}/home`);
      await expect(r.run("https://app.example.test")).rejects.toMatchObject({ exitCode: 1, message: `the app signed you in at ${CANON}; run again with --base-url ${CANON}. Nothing was saved` });
      expect(existsSync(r.m.state)).toBe(false);
      expect(r.calls).toContain("close");
      expect(r.out.join("\n")).not.toContain("SECRET");
    });

    it("the advised run then succeeds, and the file holds only that origin", async () => {
      const r = rig(canonState, `${CANON}/home`);
      expect(await r.run(CANON)).toBe(0);
      const text = readFileSync(r.m.state, "utf8");
      expect(text).not.toContain("app.example.test");
      expect(loadSettings(r.m.stateDir).verify?.browser?.baseUrl).toBe(`${CANON}/`);
    });

    it("gives the plain 'no session' message when the other origin does not hold the app cookie, when it is not https, or when the page address is unknown", async () => {
      for (const [state, page] of [
        [{ cookies: [{ name: "x", value: "v", domain: "canonical.example.test", expires: -1 }], origins: [] }, `${CANON}/`],
        [canonState, "http://canonical.example.test/"],
        [canonState, undefined],
        [canonState, "not a url"],
      ] as const) {
        const r = rig(state, page);
        const failure = await r.run("https://app.example.test").catch((e: Error) => e);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toMatch(/nothing was saved/);
        expect((failure as Error).message).not.toMatch(/signed you in at/);
        expect(existsSync(r.m.state)).toBe(false);
      }
    });

    it("does not advise when the app's own cookie is present on the base host (the base state is saved as before)", async () => {
      const r = rig(STATE, `${CANON}/home`);
      expect(await r.run("https://app.example.test")).toBe(0);
    });
  });

  it("refuses a storage-state file outside the credential floor", async () => {
    const { m, run } = rig();
    setSetting(m.stateDir, "verify.browser.storage_state", path.join(m.home, "plain.json"));
    await expect(run("https://app.example.test")).rejects.toThrow(/inside ~\/\.config\/fx-runner/);
  });

  it("the command line: help lists it, a missing or unsafe --base-url exits 2, and it exists only from the program", async () => {
    const lines: string[] = [];
    const io = { argv: ["verify-login", "--base-url", "http://example.com"], home: root, stateDirOverride: mkdtempSync(path.join(root, "cli-")), stdout: (t: string) => void lines.push(t), stderr: (t: string) => void lines.push(t) };
    expect(await runCli(io)).toBe(1); // no host: "only available from the fx-runner program"
    const { host } = rig();
    expect(await runCli({ ...io, verifyLoginHost: host })).toBe(2);
    expect(await runCli({ ...io, argv: ["verify-login"], verifyLoginHost: host })).toBe(2);
    expect(await runCli({ ...io, argv: ["--help"] })).toBe(0);
    expect(lines.join("")).toContain("verify-login --base-url");
  });
});

describe("the answer file is the job's answer", () => {
  const ENVELOPE = { journeys: [{ id: "counter", result: "pass", steps: [{ did: "clicked plus", dom_fact: "count is 1", number: 1 }], console_errors: 0, undo_checked: true, reloaded: true }] };
  const jobsDir = mkdtempSync(path.join(root, "jobs-"));
  const write = (runId: string, text: string, mode = 0o600) => {
    mkdirSync(path.join(jobsDir, runId), { recursive: true });
    writeFileSync(path.join(jobsDir, runId, "answer.json"), text, { mode });
    chmodSync(path.join(jobsDir, runId, "answer.json"), mode);
  };

  it("a valid envelope is the answer, and the file is removed once read", () => {
    write("run-valid", JSON.stringify(ENVELOPE));
    expect(readVerifyAnswer(jobsDir, "run-valid", UID)).toEqual(ENVELOPE);
    expect(existsSync(path.join(jobsDir, "run-valid", "answer.json"))).toBe(false);
  });

  it("an invalid, oversized, loose-mode, linked or missing file is no answer", () => {
    write("run-bad", JSON.stringify({ journeys: [{ id: "BAD ID", result: "pass" }] }));
    write("run-text", "the model says it passed");
    write("run-wide", JSON.stringify(ENVELOPE), 0o644);
    write("run-big", JSON.stringify({ journeys: [], pad: "x".repeat(2_000_000) }));
    mkdirSync(path.join(jobsDir, "run-link"), { recursive: true });
    symlinkSync(path.join(jobsDir, "run-valid2.json"), path.join(jobsDir, "run-link", "answer.json"));
    writeFileSync(path.join(jobsDir, "run-valid2.json"), JSON.stringify(ENVELOPE));
    for (const id of ["run-bad", "run-text", "run-wide", "run-big", "run-link", "run-none", "../escape"]) expect(readVerifyAnswer(jobsDir, id, UID), id).toBeUndefined();
  });

  it("a file whose owner is not this program's user is no answer, though its mode and content are fine", () => {
    write("run-owner", JSON.stringify(ENVELOPE));
    expect(readVerifyAnswer(jobsDir, "run-owner", UID + 1)).toBeUndefined();
    write("run-owner", JSON.stringify(ENVELOPE));
    expect(readVerifyAnswer(jobsDir, "run-owner", UID)).toEqual(ENVELOPE);
  });

  it("is opened without following a link and a link is no answer, though its target is a good file", () => {
    write("run-target", JSON.stringify(ENVELOPE));
    mkdirSync(path.join(jobsDir, "run-linked"), { recursive: true });
    symlinkSync(path.join(jobsDir, "run-target", "answer.json"), path.join(jobsDir, "run-linked", "answer.json"));
    expect(readVerifyAnswer(jobsDir, "run-linked", UID)).toBeUndefined();
    expect(existsSync(path.join(jobsDir, "run-target", "answer.json"))).toBe(true);
  });

  it.skipIf(UID === 0)("a removal that fails never throws: the answer is still returned", () => {
    write("run-stuck", JSON.stringify(ENVELOPE));
    const dir = path.join(jobsDir, "run-stuck");
    chmodSync(dir, 0o500);
    try {
      expect(readVerifyAnswer(jobsDir, "run-stuck", UID)).toEqual(ENVELOPE);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("accepts and refuses the same envelopes as V1's own parser (the shape check is a copy pinned to it)", () => {
    const base = ENVELOPE.journeys[0]!;
    const corpus: unknown[] = [ENVELOPE, { journeys: [] }, { journeys: [{ ...base, result: "maybe" }] }, { journeys: [{ ...base, extra: 1 }] }, { journeys: [{ ...base, steps: [{ did: "x" }] }] }, { journeys: [base, base] }, { journeys: [{ ...base, console_errors: -1 }] }, { nope: 1 }, [], "text"];
    for (const [i, value] of corpus.entries()) {
      write(`run-corpus-${i}`, JSON.stringify(value));
      expect(readVerifyAnswer(jobsDir, `run-corpus-${i}`, UID) !== undefined, `corpus ${i}`).toBe(parseEnvelope(value).ok);
    }
  });

  it("replaces the model's text for a playwright deploy verifier run, and for no other role or method", () => {
    const done = { status: "done", agentOutput: { journeys: "model text" } } as const;
    const answer = { journeys: [] };
    expect(withAnswerFile({ role: DEPLOY_VERIFIER_ROLE, browser_method: "playwright_runner" }, done, () => answer, "r")).toEqual({ status: "done", agentOutput: answer });
    // no file, no answer: the model's text is dropped, never kept
    expect(withAnswerFile({ role: DEPLOY_VERIFIER_ROLE, browser_method: "playwright_runner" }, done, () => undefined, "r")).toEqual({ status: "done" });
    expect(withAnswerFile({ role: DEPLOY_VERIFIER_ROLE, browser_method: "playwright_runner" }, done, undefined, "r")).toEqual({ status: "done" });
    for (const job of [{ role: DEPLOY_VERIFIER_ROLE, browser_method: "chrome_runner" as const }, { role: DEPLOY_VERIFIER_ROLE }, { role: "executor" }, { role: "executor", browser_method: "playwright_runner" as const }]) {
      expect(withAnswerFile(job, done, () => answer, "r"), JSON.stringify(job)).toBe(done);
    }
    const failed = { status: "failed" as const, reason: "x" };
    expect(withAnswerFile({ role: DEPLOY_VERIFIER_ROLE, browser_method: "playwright_runner" }, failed, () => answer, "r")).toBe(failed);
  });
});

describe("the production wiring", () => {
  const host = { input: new PassThrough(), output: new PassThrough(), env: { PATH: "/usr/bin" } };
  const flags = new Map<string, string | true>([["job-dir", "/state/jobs/r"], ["base-url", "https://app.example.test"], ["executable", "/opt/chromium"], ["storage-state", "/h/.config/fx-runner/verify/s.json"]]);

  it("never sets the certificate bypass: the built options do not carry it", () => {
    const opts = serverOptionsFrom(flags, host);
    expect(Object.keys(opts).sort()).toEqual(["baseUrl", "executablePath", "hostEnv", "input", "jobDir", "output", "storageStatePath"]);
    expect(opts.ignoreHttpsErrors).toBeUndefined();
    expect("ignoreHttpsErrors" in opts).toBe(false);
  });

  it("no file in src/ but the server and the driver (which define the test-only option) so much as names it", () => {
    const named = filesUnder(path.join(PACKAGE_DIR, "src")).filter((f) => f.endsWith(".ts") && /ignore_?https_?errors/i.test(readFileSync(f, "utf8"))).map((f) => path.relative(path.join(PACKAGE_DIR, "src"), f));
    expect(named.sort()).toEqual(["verifyBrowser/driver.ts", "verifyBrowser/server.ts"]);
    expect(readFileSync(path.join(PACKAGE_DIR, "bin", "fx-runner.mjs"), "utf8")).not.toMatch(/ignore_?https_?errors/i);
  });

  it("refuses an unsafe address, a relative path or a missing flag with exit-code-2 errors", () => {
    for (const [name, value] of [["base-url", "http://app.example.test"], ["job-dir", "relative"], ["executable", "/a/../b"], ["storage-state", "x"]] as const) {
      expect(() => serverOptionsFrom(new Map([...flags, [name, value]]), host), name).toThrow();
    }
    const missing = new Map(flags);
    missing.delete("storage-state");
    expect(() => serverOptionsFrom(missing, host)).toThrow();
  });
});
