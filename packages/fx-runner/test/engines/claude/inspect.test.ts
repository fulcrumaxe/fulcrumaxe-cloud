import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { authState, type AuthMode } from "../../../src/engines/claude/authStatus.js";
import { inspectBinary } from "../../../src/engines/claude/pin.js";
import { cleanEnv } from "../../../src/job/cleanEnv.js";
import { FULL_HELP, authText, helpWithout, makeFake } from "./harness.js";

const env = (): Record<string, string> => cleanEnv({ mode: "subscription" });
const authOpts = (binaryPath: string, timeoutMs?: number) => ({ binaryPath, env: env(), spawn, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
const made: string[] = [];
const cache = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "r4a4_inspect-"));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("authState keeps `no` apart from `unknown`", () => {
  const CASES: Array<[string, AuthMode, boolean, string, string | undefined]> = [
    // fixture, mode, exits 1, expected state, label
    ["auth.claude_ai.json", "subscription", false, "yes", "claude.ai"],
    ["auth.api_key.json", "api_key", false, "yes", "api_key"],
    ["auth.api_key.json", "subscription", false, "no", "api_key"],
    ["auth.third_party.json", "subscription", false, "no", "third_party"],
    ["auth.none.json", "subscription", true, "no", "none"],
    ["auth.claude_ai.json", "subscription", true, "no", "claude.ai"],
  ];
  it.each(CASES)("%s in %s mode, exit 1 is %s: %s", async (fixture, mode, fails, state, label) => {
    const fake = makeFake({ auth: authText(fixture) });
    if (fails) fake.set("auth.fail", "1");
    expect(await authState(mode, authOpts(fake.binary))).toEqual({ state, authMethod: label });
  });

  it("output that is not JSON, a missing or odd label, and a timeout are `unknown`, with no label", async () => {
    for (const auth of ["not json", "null", "{}", JSON.stringify({ authMethod: "claude.ai\nx" }), JSON.stringify({ authMethod: 5 })]) {
      expect(await authState("subscription", authOpts(makeFake({ auth }).binary)), auth).toEqual({ state: "unknown" });
    }
    const slow = makeFake();
    slow.set("auth.sleep", "1");
    expect(await authState("subscription", authOpts(slow.binary, 200))).toEqual({ state: "unknown" });
  });

  it("asks only `auth status` and returns nothing of the account", async () => {
    const fake = makeFake();
    const result = await authState("subscription", authOpts(fake.binary));
    expect(fake.calls()).toEqual(["auth status"]);
    expect(Object.keys(result).sort()).toEqual(["authMethod", "state"]);
  });
});

describe("inspectBinary answers without a verdict, and never throws for what the binary says", () => {
  it("a good build: its version and no missing flag", async () => {
    const fake = makeFake();
    expect(await inspectBinary({ storedPath: fake.binary, cacheDir: cache(), spawn }, env())).toEqual({ version: "2.1.294", missingFlags: [] });
  });

  it("a build below the minimum: the version, and --help is not read", async () => {
    const fake = makeFake({ version: "2.1.293 (Claude Code)" });
    expect(await inspectBinary({ storedPath: fake.binary, cacheDir: cache(), spawn }, env())).toEqual({ version: "2.1.293", missingFlags: undefined });
    expect(fake.calls()).toEqual(["--version "]);
  });

  it("an unparseable version has no version and no flag answer", async () => {
    const fake = makeFake({ version: "garbled" });
    expect(await inspectBinary({ storedPath: fake.binary, cacheDir: cache(), spawn }, env())).toEqual({ version: undefined, missingFlags: undefined });
  });

  it("a missing flag is named, and the answer is cached by version", async () => {
    const fake = makeFake({ help: helpWithout(FULL_HELP, "--tools") });
    const dir = cache();
    const first = await inspectBinary({ storedPath: fake.binary, cacheDir: dir, spawn }, env());
    expect(first.missingFlags).toEqual(["--tools"]);
    expect(JSON.parse(readFileSync(path.join(dir, "claude-flags.json"), "utf8"))["2.1.294"]).toEqual({ missing: ["--tools"] });
    await inspectBinary({ storedPath: fake.binary, cacheDir: dir, spawn }, env());
    expect(fake.calls().filter((c) => c === "--help ")).toHaveLength(1);
  });
});
