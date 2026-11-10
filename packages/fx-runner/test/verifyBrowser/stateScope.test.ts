import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { launchDriver } from "../../src/verifyBrowser/driver.js";
import { setPlaywrightLoader } from "../../src/verifyBrowser/loadPlaywright.js";
import { parseBase } from "../../src/verifyBrowser/pin.js";
import { APP_SESSION_COOKIE, keepBaseOrigin, readScopedState, scopeOf } from "../../src/verifyBrowser/stateScope.js";
import { tmpRoot } from "../helpers/tmpRoot.js";

/**
 * D#749 V2c-2b (security review): a storage-state file may hold the app's own origin and nothing else. `verify-login` cuts the state down when it saves; the probe refuses a foreign file
 * (playwrightLocal.test.ts) and the driver refuses it here, before any browser is started, so an older or hand-written file cannot bring a GitHub session into a job.
 */
const BASE = parseBase("https://app.example.test")!;
const root = mkdtempSync(path.join(tmpRoot(), "state-scope-"));
afterAll(() => {
  setPlaywrightLoader(undefined);
  rmSync(root, { recursive: true, force: true });
});
const own = { name: APP_SESSION_COOKIE, value: "OWN-SECRET", domain: "app.example.test", path: "/", expires: -1 };
const github = { name: "user_session", value: "GH-SECRET", domain: ".github.com", path: "/", expires: -1 };
const CLEAN = { cookies: [own], origins: [{ origin: "https://app.example.test", localStorage: [{ name: "a", value: "b" }] }] };

describe("scopeOf", () => {
  it("is ok for the base host's own cookies (with or without the leading dot) and its own origin's storage", () => {
    expect(scopeOf(CLEAN, BASE)).toBe("ok");
    expect(scopeOf({ cookies: [{ ...own, domain: ".app.example.test" }] }, BASE)).toBe("ok");
    expect(scopeOf({ cookies: [] }, BASE)).toBe("ok");
  });
  it("is foreign for any other host's cookie, a parent domain's cookie, or any other origin's storage (another scheme or port too)", () => {
    expect(scopeOf({ cookies: [own, github] }, BASE)).toBe("foreign");
    expect(scopeOf({ cookies: [{ ...own, domain: ".example.test" }] }, BASE)).toBe("foreign");
    expect(scopeOf({ cookies: [{ ...own, domain: "evil-app.example.test" }] }, BASE)).toBe("foreign");
    for (const origin of ["https://github.com", "http://app.example.test", "https://app.example.test:8443"]) expect(scopeOf({ cookies: [own], origins: [{ origin }] }, BASE), origin).toBe("foreign");
  });
  it("is unreadable for anything that is not a storage state", () => {
    for (const bad of [null, [], "x", {}, { cookies: "no" }, { cookies: [1] }, { cookies: [], origins: "no" }, { cookies: [], origins: [null] }]) expect(scopeOf(bad, BASE), JSON.stringify(bad)).toBe("unreadable");
  });
});

describe("keepBaseOrigin", () => {
  it("drops every cookie and every origin that is not the base's, and keeps the rest unchanged", () => {
    const kept = keepBaseOrigin({ cookies: [own, github, { ...own, domain: ".example.test" }], origins: [...CLEAN.origins, { origin: "https://github.com", localStorage: [] }] }, BASE);
    expect(kept).toEqual(CLEAN);
    expect(scopeOf(kept, BASE)).toBe("ok");
  });
});

describe("readScopedState and the driver", () => {
  const dir = mkdtempSync(path.join(root, "files-"));
  let n = 0;
  const file = (content: unknown, mode = 0o600): string => {
    const target = path.join(dir, `s${(n += 1)}.json`);
    writeFileSync(target, typeof content === "string" ? content : JSON.stringify(content), { mode });
    chmodSync(target, mode);
    return target;
  };

  it("returns the checked state of a clean private file", () => {
    expect(readScopedState(file(CLEAN), BASE)).toEqual({ ok: true, state: CLEAN });
  });

  it("refuses a foreign file with its own closed code, and never repeats its content", () => {
    const result = readScopedState(file({ cookies: [own, github], origins: [] }), BASE);
    expect(result).toEqual({ ok: false, code: "storage_state_foreign" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("refuses a link, a loose mode, a missing file and text that is not a state", () => {
    const real = file(CLEAN);
    const link = path.join(dir, "link.json");
    symlinkSync(real, link);
    expect(readScopedState(link, BASE)).toEqual({ ok: false, code: "storage_state_unreadable" });
    expect(readScopedState(file(CLEAN, 0o644), BASE)).toEqual({ ok: false, code: "storage_state_unreadable" });
    expect(readScopedState(path.join(dir, "missing.json"), BASE)).toEqual({ ok: false, code: "storage_state_unreadable" });
    expect(readScopedState(file("not json"), BASE)).toEqual({ ok: false, code: "storage_state_unreadable" });
  });

  it("launchDriver refuses a foreign file before it makes a folder or starts anything", async () => {
    setPlaywrightLoader(undefined);
    const jobDir = mkdtempSync(path.join(root, "job-"));
    const cfg = { base: BASE, executablePath: "/nonexistent/chromium", jobDir, hostEnv: {}, onConsole: () => undefined };
    await expect(launchDriver({ ...cfg, storageStatePath: file({ cookies: [own, github], origins: [] }) })).rejects.toMatchObject({ code: "storage_state_foreign" });
    await expect(launchDriver({ ...cfg, storageStatePath: file({ cookies: [own], origins: [{ origin: "https://github.com", localStorage: [] }] }) })).rejects.toMatchObject({ code: "storage_state_foreign" });
    expect(existsSync(path.join(jobDir, "home"))).toBe(false);
    expect(existsSync(path.join(jobDir, "tmp"))).toBe(false);
    // control: a clean file passes the check and reaches the next step, which (no library installed here) is the closed code playwright_missing
    await expect(launchDriver({ ...cfg, storageStatePath: file(CLEAN) })).rejects.toMatchObject({ code: "playwright_missing" });
    mkdirSync(path.join(jobDir, "unused"), { recursive: true });
  });
});
