import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { LastTestedError, lastTestedPath, readLastTested, recordLastTested, type LastTestedEntry } from "../src/last-tested.js";

const entry = (over: Partial<LastTestedEntry> = {}): LastTestedEntry => ({ commit: "abcdef1234567", tier: "smoke", outcome: "pass", at: "2026-10-08T01:02:03.000Z", ...over });
const tempHome = () => mkdtempSync(join(tmpdir(), "le2e-home-"));

describe("last-tested store", () => {
  it("is empty, without a warning, when the file does not exist", () => {
    const warnings: string[] = [];
    expect(readLastTested(tempHome(), (w) => warnings.push(w))).toEqual({ version: 1, targets: {} });
    expect(warnings).toEqual([]);
  });

  it("records per target at $HOME/.local/state/live-e2e/last-tested.json with mode 0600", () => {
    const home = tempHome();
    recordLastTested(home, "staging", entry());
    recordLastTested(home, "production", entry({ commit: "1234567", outcome: "fail", tier: "standard" }));
    const file = lastTestedPath(home);
    expect(file).toBe(join(home, ".local", "state", "live-e2e", "last-tested.json"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o077).toBe(0);
    const stored = JSON.parse(readFileSync(file, "utf8")) as { targets: Record<string, LastTestedEntry> };
    expect(stored.targets["staging"]).toEqual(entry());
    expect(stored.targets["production"]?.outcome).toBe("fail");
  });

  it("writes by rename: no temp file is left behind, and a later record replaces the earlier entry", () => {
    const home = tempHome();
    recordLastTested(home, "staging", entry());
    recordLastTested(home, "staging", entry({ commit: "fedcba9876543" }));
    expect(readdirSync(dirname(lastTestedPath(home)))).toEqual(["last-tested.json"]);
    expect(readLastTested(home).targets["staging"]?.commit).toBe("fedcba9876543");
  });

  it("reads a corrupt file as empty with a warning, never a crash, and the next record repairs it", () => {
    const home = tempHome();
    mkdirSync(dirname(lastTestedPath(home)), { recursive: true });
    writeFileSync(lastTestedPath(home), "{ not json");
    const warnings: string[] = [];
    expect(readLastTested(home, (w) => warnings.push(w))).toEqual({ version: 1, targets: {} });
    expect(warnings).toHaveLength(1);
    recordLastTested(home, "staging", entry());
    expect(readLastTested(home).targets["staging"]).toEqual(entry());
  });

  it("drops an invalid entry with a warning and keeps the valid ones", () => {
    const home = tempHome();
    mkdirSync(dirname(lastTestedPath(home)), { recursive: true });
    writeFileSync(lastTestedPath(home), JSON.stringify({ version: 1, targets: { staging: entry(), production: { commit: "not-hex" } } }));
    const warnings: string[] = [];
    const store = readLastTested(home, (w) => warnings.push(w));
    expect(Object.keys(store.targets)).toEqual(["staging"]);
    expect(warnings).toHaveLength(1);
  });

  it("refuses a relative HOME, a bad target and an invalid entry", () => {
    expect(() => lastTestedPath("relative/home")).toThrow(LastTestedError);
    expect(() => recordLastTested(tempHome(), "../x", entry())).toThrow("target");
    expect(() => recordLastTested(tempHome(), "staging", entry({ commit: "xyz" }))).toThrow("entry");
    expect(() => recordLastTested(tempHome(), "staging", entry({ outcome: "green" as never }))).toThrow("entry");
  });
});

describe("cli: live-e2e last-tested", () => {
  function run(home: string, argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    return main(["last-tested", ...argv], { root: ".", cwd: ".", env: { HOME: home }, host: {} as never, stdout: (l) => out.push(l), stderr: (l) => err.push(l) }).then((code) => ({ code, out, err }));
  }

  it("records, then shows the entry as JSON; an unknown target shows {}", async () => {
    const home = tempHome();
    expect((await run(home, ["record", "--target", "staging", "--commit", "abcdef1", "--tier", "smoke", "--outcome", "pass"])).code).toBe(0);
    const shown = await run(home, ["show", "--target", "staging"]);
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.out[0] as string)).toMatchObject({ commit: "abcdef1", tier: "smoke", outcome: "pass" });
    expect((await run(home, ["show", "--target", "production"])).out).toEqual(["{}"]);
  });

  it("exits 2 on a missing flag, an unknown outcome or an unknown tier", async () => {
    const home = tempHome();
    expect((await run(home, ["record", "--target", "staging"])).code).toBe(2);
    expect((await run(home, ["record", "--target", "staging", "--commit", "abcdef1", "--tier", "smoke", "--outcome", "maybe"])).code).toBe(2);
    expect((await run(home, ["record", "--target", "staging", "--commit", "abcdef1", "--tier", "huge", "--outcome", "pass"])).code).toBe(2);
    expect((await run(home, ["wipe", "--target", "staging"])).code).toBe(2);
  });
});
