import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHROMIUM_SOCKET_NAME_ROOM, UNIX_SOCKET_PATH_MAX, browserTmpParent, findChromium, launchDriver } from "../../src/verifyBrowser/driver.js";
import { parseBase, type BasePin } from "../../src/verifyBrowser/pin.js";
import { chromiumSandboxRefused } from "../helpers/chromiumSandbox.js";
import { tmpRoot } from "../helpers/tmpRoot.js";
import { useSourcePlaywright } from "./sourceLoader.js";

/**
 * D#749: the verify browser must start from a job directory as long as the runner's real one (`~/.fx-runner/jobs/<uuid>`). It did not: the browser's TMPDIR was `<jobDir>/tmp`, and
 * Chromium's singleton socket there (`<TMPDIR>/org.chromium.Chromium.XXXXXX/SingletonSocket`) passed the 107-byte Unix socket limit, so Chromium stopped at start ("Socket path too
 * long") and every browser tool answered `action_failed`. The other real-browser suites build short temporary directories and never met the limit.
 */
// Both kinds the runner can be set to: the headless shell, and the full Chromium that `verify-login` saves as the setting (`findHeaded`). Only the full one makes the singleton socket.
const EXES = [...new Set([findChromium(process.env, { headed: true }), findChromium(process.env)].filter((e): e is string => e !== undefined))];
const NO_SANDBOX = EXES.some((e) => chromiumSandboxRefused(e));
useSourcePlaywright();

let app: Server;
let base: BasePin;
let work = "";
beforeAll(async () => {
  work = mkdtempSync(path.join(tmpRoot(), "pw-long-"));
  app = createServer((_q, res) => void res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><h1>Orders</h1><p>Total: 3</p>"));
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  base = parseBase(`http://127.0.0.1:${(app.address() as AddressInfo).port}`)!;
});
afterAll(() => {
  app?.close();
  if (work !== "") rmSync(work, { recursive: true, force: true });
});

/** A job directory at least as long as `/home/<user>/.fx-runner/jobs/<uuid>`. */
function longJobDir(): string {
  const dir = path.join(work, "home-of-a-person-with-a-long-name", ".fx-runner", "jobs", "22b338ef-d14b-4344-b9a0-b777848de0a6");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  expect(path.join(dir, "tmp", "org.chromium.Chromium.XXXXXX", "SingletonSocket").length).toBeGreaterThan(UNIX_SOCKET_PATH_MAX);
  return dir;
}

describe("the browser's temporary directory", () => {
  it("is short: the deepest socket Chromium makes under it fits a Unix socket path", () => {
    const parent = browserTmpParent();
    expect(parent).toBeDefined();
    expect(path.join(parent!, "fxv-XXXXXX").length + CHROMIUM_SOCKET_NAME_ROOM).toBeLessThanOrEqual(UNIX_SOCKET_PATH_MAX);
  });

  it("no candidate short enough: none is chosen (the launch then refuses with a closed code instead of a browser that dies at start)", () => {
    expect(browserTmpParent([undefined, "relative/dir", path.join(work, "missing")])).toBeUndefined();
    expect(browserTmpParent([])).toBeUndefined();
  });

  it("the length check: a real, writable folder one byte too long is skipped, one that just fits is taken, and bytes are counted, not characters", () => {
    const room = Buffer.byteLength("/fxv-XXXXXX") + CHROMIUM_SOCKET_NAME_ROOM;
    const fits = path.join(work, "f".repeat(UNIX_SOCKET_PATH_MAX - room - work.length - 1));
    const over = `${fits}g`;
    for (const dir of [fits, over]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    expect(Buffer.byteLength(fits) + room).toBe(UNIX_SOCKET_PATH_MAX);
    expect(browserTmpParent([fits])).toBe(fits);
    // The runner's own TMPDIR can be this long: it is skipped and /tmp is used instead.
    expect(browserTmpParent([over])).toBeUndefined();
    expect(browserTmpParent([over, "/tmp"])).toBe("/tmp");
    // The same number of characters as `fits`, but two of them take two bytes each.
    const wide = path.join(work, `\u00e9\u00e9${"f".repeat(path.basename(fits).length - 2)}`);
    mkdirSync(wide, { mode: 0o700 });
    expect(wide.length).toBe(fits.length);
    expect(browserTmpParent([wide])).toBeUndefined();
  });

  it("a browser program that exits at start is named browser_start_failed (not the generic action_failed), and its folders are removed", async () => {
    const jobDir = longJobDir();
    const exe = path.join(work, "chromium-that-dies");
    writeFileSync(exe, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    // A private short TMPDIR, so the folder the launch made there (and must remove) is this launch's alone.
    const parent = mkdtempSync(path.join("/tmp", "ld-"));
    await expect(launchDriver({ base, executablePath: exe, jobDir, hostEnv: { PATH: process.env.PATH, TMPDIR: parent }, onConsole: () => undefined })).rejects.toMatchObject({ code: "browser_start_failed" });
    expect(readdirSync(parent)).toEqual([]);
    expect(readdirSync(jobDir)).toEqual([]);
    rmSync(parent, { recursive: true, force: true });
    rmSync(jobDir, { recursive: true, force: true });
  }, 60_000);

  it.skipIf(EXES.length === 0 || NO_SANDBOX).each(EXES)("a real Chromium (%s) starts and loads the page from a job directory as long as the runner's, and leaves no temporary directory behind", async (exe) => {
    const jobDir = longJobDir();
    // A short temp directory of this test's own, handed in as the runner's TMPDIR, so what the browser leaves there is this launch's alone.
    const parent = mkdtempSync(path.join(browserTmpParent()!, "lj-"));
    expect(browserTmpParent([parent, "/tmp"])).toBe(parent);
    const driver = await launchDriver({ base, executablePath: exe, jobDir, hostEnv: { PATH: process.env.PATH, TMPDIR: parent }, onConsole: () => undefined });
    try {
      await driver.go(`${base.origin}/`);
      expect(await driver.waitText("Total: 3", 10_000)).toBe(true);
    } finally {
      await driver.close();
    }
    expect(readdirSync(parent)).toEqual([]);
    rmSync(parent, { recursive: true, force: true });
    expect(existsSync(path.join(jobDir, "home"))).toBe(false);
    expect(readdirSync(jobDir)).toEqual([]);
    rmSync(jobDir, { recursive: true, force: true });
  }, 60_000);
});
