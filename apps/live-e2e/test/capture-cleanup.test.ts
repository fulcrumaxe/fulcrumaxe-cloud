/**
 * The capture profile holds the github.com session and the bypass cookie, so it must not outlive the capture:
 * a handled signal removes it (real child process, real headless browser), and every capture sweeps what a SIGKILL
 * left behind (never a symlink, never a young folder, never anything outside the temp root).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CAPTURE_PREFIX, captureSession, STALE_PROFILE_MS, sweepStaleProfiles, type Launcher } from "../src/sessions.js";
import { makeTarget, PACKAGE_ROOT } from "./helpers.js";

const scratch = (): string => mkdtempSync(join(tmpdir(), "t3_cleanup_"));
const ago = (path: string, ms: number): void => {
  const t = new Date(Date.now() - ms);
  utimesSync(path, t, t);
};

describe("sweepStaleProfiles", () => {
  it("removes a stale capture folder with its contents, and leaves young ones, other names and files alone", () => {
    const root = scratch();
    const stale = join(root, `${CAPTURE_PREFIX}old`);
    mkdirSync(join(stale, "Default"), { recursive: true });
    writeFileSync(join(stale, "Default", "Cookies"), "github.com session");
    ago(stale, STALE_PROFILE_MS + 60_000);
    const young = join(root, `${CAPTURE_PREFIX}young`);
    mkdirSync(young);
    ago(young, STALE_PROFILE_MS - 60_000);
    const other = join(root, "other-folder");
    mkdirSync(other);
    ago(other, 10 * STALE_PROFILE_MS);
    const file = join(root, `${CAPTURE_PREFIX}file`);
    writeFileSync(file, "x");
    ago(file, 10 * STALE_PROFILE_MS);
    expect(sweepStaleProfiles(root)).toEqual([`${CAPTURE_PREFIX}old`]);
    expect(readdirSync(root).sort()).toEqual([`${CAPTURE_PREFIX}file`, `${CAPTURE_PREFIX}young`, "other-folder"].sort());
  });

  it("never follows or removes a symlink, however old, and leaves what it points at intact", () => {
    const root = scratch();
    const elsewhere = scratch();
    writeFileSync(join(elsewhere, "keep.txt"), "not a capture profile");
    const link = join(root, `${CAPTURE_PREFIX}link`);
    symlinkSync(elsewhere, link);
    ago(elsewhere, 10 * STALE_PROFILE_MS);
    expect(sweepStaleProfiles(root, Date.now() + 10 * STALE_PROFILE_MS)).toEqual([]);
    expect(existsSync(link)).toBe(true);
    expect(readdirSync(elsewhere)).toEqual(["keep.txt"]);
  });

  it("an unreadable or missing root is not an error", () => {
    expect(sweepStaleProfiles(join(scratch(), "nope"))).toEqual([]);
  });

  it("every capture sweeps first: a planted stale folder is gone once the next capture has run", async () => {
    const root = scratch();
    const stale = join(root, `${CAPTURE_PREFIX}leftover`);
    mkdirSync(stale);
    ago(stale, STALE_PROFILE_MS + 60_000);
    const launcher: Launcher = async () => ({ cookie: async () => undefined, close: async () => undefined });
    let t = 0;
    await expect(captureSession({ target: makeTarget(), launcher, profileRoot: root, now: () => (t += 10_000), timeoutMs: 20_000, pollMs: 1 })).rejects.toThrow("nothing was stored");
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("a signal during a real capture", () => {
  const SCRIPT = join(PACKAGE_ROOT, "test", "fixtures", "capture-signal.ts");

  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    it(`${signal} closes the browser, removes the profile and exits ${code}`, async () => {
      const root = scratch();
      const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, root], { cwd: PACKAGE_ROOT, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      const exited = new Promise<number | null>((resolve) => child.on("close", (c) => resolve(c)));
      const deadline = Date.now() + 45_000;
      while (!out.includes("READY")) {
        if (Date.now() > deadline) {
          child.kill("SIGKILL");
          throw new Error(`the capture never became ready: ${err.slice(0, 400)}`);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(readdirSync(root).filter((n) => n.startsWith(CAPTURE_PREFIX))).toHaveLength(1);
      child.kill(signal);
      expect(await exited).toBe(code);
      expect(readdirSync(root)).toEqual([]);
    }, 90_000);
  }
});
