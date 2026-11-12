import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { clearVerifyLeftovers } from "../../src/engines/claude/settingsFile.js";
import { launchDriver } from "../../src/verifyBrowser/driver.js";
import { setPlaywrightLoader } from "../../src/verifyBrowser/loadPlaywright.js";
import { parseBase } from "../../src/verifyBrowser/pin.js";
import { BROWSER_TMP_RECORD } from "../../src/verifyBrowser/tmpRecord.js";

/**
 * D#749 (CWE-459): the verify browser's folders never outlive a launch that is refused, and a re-claimed job removes the TMPDIR a killed server left outside its job directory.
 * The server tries the launch again on every tool call, so a refusal that left its HOME behind would also make the next try fail on the folder that is already there.
 */
const base = parseBase("https://app.example.test")!;
const work = mkdtempSync(path.join("/tmp", "btl-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
afterEach(() => setPlaywrightLoader(undefined));

const fresh = (name: string) => {
  const jobDir = path.join(work, name, "job");
  const tmp = path.join(work, name, "t");
  mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  return { jobDir, tmp };
};

describe("a launch refused because Playwright cannot load", () => {
  it("leaves no fxv- folder, no HOME and no record, and refuses the same way on the next try (not EEXIST -> action_failed)", async () => {
    const { jobDir, tmp } = fresh("pw-missing");
    setPlaywrightLoader({ available: () => false, load: async () => { throw new Error("no library at /some/path"); } });
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(launchDriver({ base, executablePath: "/opt/chromium", jobDir, hostEnv: { TMPDIR: tmp }, onConsole: () => undefined })).rejects.toMatchObject({ code: "playwright_missing" });
      expect(readdirSync(tmp), `attempt ${attempt}`).toEqual([]);
      expect(readdirSync(jobDir), `attempt ${attempt}`).toEqual([]);
    }
  });
});

describe("clearVerifyLeftovers removes a killed server's TMPDIR through the record", () => {
  it("removes the recorded fxv- folder and the record", () => {
    const { jobDir, tmp } = fresh("clear");
    const left = path.join(tmp, "fxv-Ab12Cd");
    mkdirSync(path.join(left, "org.chromium.Chromium.xyz"), { recursive: true, mode: 0o700 });
    chmodSync(left, 0o700);
    writeFileSync(path.join(jobDir, BROWSER_TMP_RECORD), left, { mode: 0o600 });
    mkdirSync(path.join(jobDir, "home"), { mode: 0o700 });
    clearVerifyLeftovers(jobDir);
    expect(existsSync(left)).toBe(false);
    expect(readdirSync(jobDir)).toEqual([]);
  });

  it("follows nothing else: a name that is not driver-made, a relative path, a link, a folder others can enter, or a loose record are left alone (the record itself is removed)", () => {
    const { jobDir, tmp } = fresh("refuse");
    const keep = path.join(tmp, "precious");
    mkdirSync(keep, { mode: 0o700 });
    const real = path.join(tmp, "fxv-Real01");
    mkdirSync(real, { mode: 0o700 });
    const link = path.join(tmp, "fxv-Link01");
    symlinkSync(real, link);
    const open = path.join(tmp, "fxv-Open01");
    mkdirSync(open, { mode: 0o700 });
    chmodSync(open, 0o755);
    const record = path.join(jobDir, BROWSER_TMP_RECORD);
    for (const [named, mode] of [[keep, 0o600], ["fxv-Real01", 0o600], [link, 0o600], [open, 0o600], [`${real}/../precious`, 0o600], [real, 0o644]] as const) {
      writeFileSync(record, named, { mode });
      chmodSync(record, mode);
      clearVerifyLeftovers(jobDir);
      expect(existsSync(record), named).toBe(false);
    }
    expect([keep, real, open].every((d) => existsSync(d))).toBe(true);
    expect(existsSync(link)).toBe(true);
  });
});
