import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeArgv } from "../../../src/engines/claude/argv.js";
import { canaryArgvFingerprint, runInstructionCanary } from "../../../src/engines/claude/instructionCanary.js";
import { canaryGuardedSource, createClaudeKit } from "../../../src/engines/claude/kit.js";
import { cleanEnv } from "../../../src/job/cleanEnv.js";
import { storedBinarySource } from "../../../src/engines/claude/pin.js";
import { FULL_HELP } from "./harness.js";
import { CANARY_STATE_FILE, type InstructionCanaryResult, claimBlockReason, ensureInstructionCanary, readCanaryState } from "../../../src/instructionCanaryState.js";
import { testLaunch } from "../../helpers/launch.js";

/**
 * D#601 MEM-7. These tests use a stand-in program that behaves as the CLI is documented to (`--setting-sources` empty or `user`: a CLAUDE.md in
 * the working directory is not loaded; `project`: it is). A stand-in cannot prove what a real build does; `instructionCanary.real.test.ts` does that
 * against the installed CLI. What is proved here is the runner's side: the arguments, the directory, the verdicts and what is stored.
 */
let dir: string;
let argvLog: string;
let fakeBin: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "m7-"));
  argvLog = path.join(dir, "argv.log");
  fakeBin = path.join(dir, "stand-in-cli");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** `mode`: "honours" loads CLAUDE.md only for `project`; "always" loads it whatever the sources; "crash" exits 1; "silent" exits 0 with no result line. */
function installFake(mode: "honours" | "always" | "crash" | "silent"): void {
  writeFileSync(
    fakeBin,
    `#!/bin/sh
printf '%s\\n' "$@" > "${argvLog}"
printf '%s\\n' "$PWD" > "${argvLog}.cwd"
[ "${mode}" = crash ] && exit 1
[ "${mode}" = silent ] && { echo '{"type":"system","subtype":"init"}'; exit 0; }
src=x; prev=
for a in "$@"; do [ "$prev" = "--setting-sources" ] && src="$a"; prev="$a"; done
if [ -f CLAUDE.md ] && { [ "${mode}" = always ] || [ "$src" = project ]; }; then
  tok=$(grep -o 'FXCANARY-[0-9a-f]*' CLAUDE.md)
  echo "{\\"type\\":\\"assistant\\",\\"text\\":\\"$tok hello\\"}"
fi
echo '{"type":"result","subtype":"success","is_error":false}'
`,
  );
  chmodSync(fakeBin, 0o755);
}
const check = (over: Partial<Parameters<typeof runInstructionCanary>[0]> = {}) => runInstructionCanary({ binaryPath: fakeBin, env: { PATH: process.env.PATH ?? "" }, spawn, tempRoot: dir, ...over });
const argvSeen = (): string[] => readFileSync(argvLog, "utf8").trimEnd().split("\n");

describe("the instruction-file canary (MEM-7)", () => {
  it("passes when the CLI keeps the file out under the engine's `--setting-sources \"\"`", async () => {
    installFake("honours");
    expect(await check()).toEqual({ ok: true });
  });

  it("fails as instruction_file_loaded when the same CLI is given `project`", async () => {
    installFake("honours");
    expect(await check({ settingSources: "project" })).toEqual({ ok: false, reason: "instruction_file_loaded" });
  });

  it("fails as instruction_file_loaded when a build loads the file whatever the sources say", async () => {
    installFake("always");
    expect(await check()).toEqual({ ok: false, reason: "instruction_file_loaded" });
  });

  it("runs the engine's own argument list: only the setting-sources value may differ, and the prompt is not in it", async () => {
    installFake("honours");
    await check();
    const seen = argvSeen();
    const expected = claudeArgv({ cliModel: "haiku", roleTools: [], allowRules: [], settingsPath: seen[seen.indexOf("--settings") + 1]!, mcpPath: seen[seen.indexOf("--mcp-config") + 1]! });
    expect(seen).toEqual(expected);
    expect(seen[seen.indexOf("--setting-sources") + 1]).toBe("");
    expect(seen.join(" ")).not.toMatch(/FXCANARY|CLAUDE\.md|hello/);
  });

  it("runs in a directory that holds the canary file, and leaves nothing behind", async () => {
    installFake("honours");
    await check();
    const cwd = readFileSync(`${argvLog}.cwd`, "utf8").trim();
    expect(cwd.startsWith(dir)).toBe(true);
    expect(existsSync(cwd)).toBe(false);
    expect(readdirSync(dir).filter((name) => name.startsWith("fxr-canary-"))).toEqual([]);
  });

  it("a crash, or a run that never answered, proves nothing: inconclusive, never a pass", async () => {
    installFake("crash");
    expect(await check()).toEqual({ ok: false, reason: "instruction_canary_inconclusive" });
    installFake("silent");
    expect(await check()).toEqual({ ok: false, reason: "instruction_canary_inconclusive" });
    expect(await check({ binaryPath: path.join(dir, "missing") })).toEqual({ ok: false, reason: "instruction_canary_inconclusive" });
  });

  it("the argument fingerprint is a short hash of the engine's argument list", () => {
    expect(canaryArgvFingerprint()).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("the stored answer and the claim block (MEM-7)", () => {
  const base = (over: Partial<Parameters<typeof ensureInstructionCanary>[0]>) => ({ stateDir: dir, binaryPath: "/bin/claude", binaryVersion: "2.1.295", argv: "k1", now: () => new Date("2026-10-17T10:00:00Z"), check: async (): Promise<InstructionCanaryResult> => ({ ok: true }), ...over });

  it("a pass is stored privately and not asked again for the same path, version and arguments", async () => {
    let calls = 0;
    const counted = async (): Promise<InstructionCanaryResult> => {
      calls++;
      return { ok: true };
    };
    expect(await ensureInstructionCanary(base({ check: counted }))).toBeUndefined();
    expect(await ensureInstructionCanary(base({ check: counted }))).toBeUndefined();
    expect(calls).toBe(1);
    expect(statSync(path.join(dir, CANARY_STATE_FILE)).mode & 0o777).toBe(0o600);
    expect(claimBlockReason(dir)).toBeUndefined();
    expect(await ensureInstructionCanary(base({ check: counted, binaryVersion: "2.1.296" }))).toBeUndefined();
    expect(await ensureInstructionCanary(base({ check: counted, argv: "k2" }))).toBeUndefined();
    expect(await ensureInstructionCanary(base({ check: counted, binaryPath: "/other/claude" }))).toBeUndefined();
    expect(calls).toBe(4);
  });

  it("an unreadable version is never a cached pass", async () => {
    let calls = 0;
    const counted = async (): Promise<InstructionCanaryResult> => {
      calls++;
      return { ok: true };
    };
    await ensureInstructionCanary(base({ check: counted, binaryVersion: undefined }));
    await ensureInstructionCanary(base({ check: counted, binaryVersion: undefined }));
    expect(calls).toBe(2);
  });

  it("a failure is stored with its named reason, blocks claiming, and is checked again at the next start", async () => {
    expect(await ensureInstructionCanary(base({ check: async () => ({ ok: false, reason: "instruction_file_loaded" }) }))).toBe("instruction_file_loaded");
    expect(claimBlockReason(dir)).toBe("instruction_file_loaded");
    expect(readCanaryState(dir)).toMatchObject({ status: "blocked", reason: "instruction_file_loaded", binary_version: "2.1.295" });
    // The same build is checked again (a failure is never cached); this time it passes and the block lifts.
    expect(await ensureInstructionCanary(base({}))).toBeUndefined();
    expect(claimBlockReason(dir)).toBeUndefined();
  });

  it("a check that throws is the inconclusive block", async () => {
    const throwing = async (): Promise<never> => {
      throw new Error("boom");
    };
    expect(await ensureInstructionCanary(base({ check: throwing }))).toBe("instruction_canary_inconclusive");
    expect(claimBlockReason(dir)).toBe("instruction_canary_inconclusive");
  });

  it("a damaged or foreign state file is not a block and not a pass", () => {
    writeFileSync(path.join(dir, CANARY_STATE_FILE), '{"status":"blocked","reason":"anything else"}');
    expect(readCanaryState(dir)).toBeUndefined();
    writeFileSync(path.join(dir, CANARY_STATE_FILE), "not json");
    expect(claimBlockReason(dir)).toBeUndefined();
  });
});

describe("the kit", () => {
  it("offers the check only when the program's entry point asks for it, so tests that count spawns see none", () => {
    expect(createClaudeKit(spawn, { launch: testLaunch() }).instructionCanary).toBeUndefined();
    expect(createClaudeKit(spawn, { instructionCanary: true, launch: testLaunch() }).instructionCanary).toBeTypeOf("function");
    expect(createClaudeKit(spawn, { instructionCanary: true, launch: testLaunch() }).instructionCanaryKey!()).toBe(canaryArgvFingerprint());
    expect(readFileSync(path.join(import.meta.dirname, "../../../bin/fx-runner.mjs"), "utf8")).toContain("createClaudeKit(spawn, { instructionCanary: true, launch })");
  });
});

describe("a build that changes under the running daemon (MEM-7, CWE-367)", () => {
  /** A stand-in that answers `--version` from a file we can change between jobs, `--help` with the full flag list, and a canary turn otherwise. */
  function installVersioned(canary: "honours" | "always" | "crash"): void {
    writeFileSync(path.join(dir, "version"), "2.1.295 (Claude Code)\n");
    writeFileSync(path.join(dir, "help.txt"), FULL_HELP);
    writeFileSync(
      fakeBin,
      `#!/bin/sh
[ "$1" = "--version" ] && { cat "${dir}/version"; exit 0; }
[ "$1" = "--help" ] && { cat "${dir}/help.txt"; exit 0; }
echo run >> "${dir}/turns"
# A test may close the gate (a file named "gate") to hold the canary turn until it creates "release"; bounded at about 20 s so a failed test cannot hang.
if [ -f "${dir}/gate" ]; then n=0; while [ ! -f "${dir}/release" ] && [ "$n" -lt 1000 ]; do sleep 0.02; n=$((n+1)); done; fi
[ "${canary}" = crash ] && exit 1
src=x; prev=
for a in "$@"; do [ "$prev" = "--setting-sources" ] && src="$a"; prev="$a"; done
if [ -f CLAUDE.md ] && { [ "${canary}" = always ] || [ "$src" = project ]; }; then
  tok=$(grep -o 'FXCANARY-[0-9a-f]*' CLAUDE.md)
  echo "{\\"type\\":\\"assistant\\",\\"text\\":\\"$tok hello\\"}"
fi
echo '{"type":"result","subtype":"success","is_error":false}'
`,
    );
    chmodSync(fakeBin, 0o755);
  }
  const turns = (): number => (existsSync(path.join(dir, "turns")) ? readFileSync(path.join(dir, "turns"), "utf8").trim().split("\n").length : 0);
  const env = (): Record<string, string> => ({ PATH: process.env.PATH ?? "" });
  const source = () =>
    canaryGuardedSource({ binaryPath: fakeBin, stateDir: dir }, storedBinarySource({ launch: testLaunch(), storedPath: fakeBin, cacheDir: dir, spawn }), () => runInstructionCanary({ binaryPath: fakeBin, env: cleanEnv({ mode: "subscription" }), spawn, tempRoot: dir }));
  const startup = (version: string) =>
    ensureInstructionCanary({ stateDir: dir, binaryPath: fakeBin, binaryVersion: version, argv: canaryArgvFingerprint(), now: () => new Date("2026-10-17T10:00:00Z"), check: async () => ({ ok: true }) });

  it("the checked build runs jobs; a new version refuses the next job unstarted, checks once, and a pass lets claiming resume", async () => {
    installVersioned("honours");
    await startup("2.1.295");
    await expect(source()(env())).resolves.toMatchObject({ version: "2.1.295" });
    expect(turns()).toBe(0);
    // An in-place update: the same path, a new version.
    writeFileSync(path.join(dir, "version"), "2.1.296 (Claude Code)\n");
    await expect(source()(env())).rejects.toMatchObject({ code: "claude_version_unsupported", message: expect.stringContaining("2.1.296") });
    expect(turns()).toBe(1);
    // The check ran for the new build, passed, and stored it: claiming is open again and the next job runs.
    expect(readCanaryState(dir)).toMatchObject({ status: "passed", binary_version: "2.1.296" });
    expect(claimBlockReason(dir)).toBeUndefined();
    await expect(source()(env())).resolves.toMatchObject({ version: "2.1.296" });
    expect(turns()).toBe(1);
  });

  it("a new build that loads the file keeps the block: claiming stays held and later jobs are refused without another model turn", async () => {
    installVersioned("always");
    await startup("2.1.295");
    writeFileSync(path.join(dir, "version"), "2.1.296 (Claude Code)\n");
    await expect(source()(env())).rejects.toMatchObject({ code: "claude_version_unsupported" });
    expect(claimBlockReason(dir)).toBe("instruction_file_loaded");
    await expect(source()(env())).rejects.toMatchObject({ code: "claude_version_unsupported" });
    expect(turns()).toBe(1);
  });

  it("a new build whose check cannot finish keeps the block: the job is refused, claiming stays held, later jobs cost no turn, and no pass is stored", async () => {
    installVersioned("crash");
    await startup("2.1.295");
    writeFileSync(path.join(dir, "version"), "2.1.296 (Claude Code)\n");
    await expect(source()(env())).rejects.toMatchObject({ code: "claude_version_unsupported" });
    expect(turns()).toBe(1);
    expect(claimBlockReason(dir)).toBe("instruction_canary_inconclusive");
    expect(readCanaryState(dir)).toMatchObject({ status: "blocked", reason: "instruction_canary_inconclusive", binary_version: "2.1.296" });
    await expect(source()(env())).rejects.toMatchObject({ code: "claude_version_unsupported" });
    expect(turns()).toBe(1);
    expect(claimBlockReason(dir)).toBe("instruction_canary_inconclusive");
    expect(readCanaryState(dir)?.status).not.toBe("passed");
  });

  it("claiming is held while the check for the new build is still running: several jobs at once are all refused, one turn runs", async () => {
    installVersioned("honours");
    await startup("2.1.295");
    writeFileSync(path.join(dir, "version"), "2.1.296 (Claude Code)\n");
    // The stand-in's canary turn is gated: it does not answer until the test creates "release", which it does only after the two jobs that did not
    // start the check have been refused. Nothing here depends on how fast the stand-in or the machine is.
    writeFileSync(path.join(dir, "gate"), "");
    const until = async (what: string, done: () => boolean): Promise<void> => {
      const deadline = Date.now() + 15_000;
      while (!done()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    const settled: string[] = [];
    let holds = 0;
    let jobs: Promise<string[]> | undefined;
    try {
      const issued = [source()(env()), source()(env()), source()(env())].map((job) => job.then(() => "ran", (error: { code?: string }) => error.code ?? "other"));
      jobs = Promise.all(issued.map((job) => job.then((outcome) => (settled.push(outcome), outcome))));
      // One job started the check (its turn is under way, held at the gate); the other two were refused while the check was still running.
      await until("the check's turn to start and two jobs to be refused", () => turns() === 1 && settled.length === 2);
      if (claimBlockReason(dir) === "instruction_canary_inconclusive") holds++;
      expect(settled).toEqual(["claude_version_unsupported", "claude_version_unsupported"]);
      expect(readCanaryState(dir)).toMatchObject({ status: "blocked", reason: "instruction_canary_inconclusive", binary_version: "2.1.296" });
    } finally {
      writeFileSync(path.join(dir, "release"), "");
    }
    expect(await jobs).toEqual(["claude_version_unsupported", "claude_version_unsupported", "claude_version_unsupported"]);
    expect(turns()).toBe(1);
    expect(holds).toBe(1);
    expect(readCanaryState(dir)).toMatchObject({ status: "passed", binary_version: "2.1.296" });
    expect(claimBlockReason(dir)).toBeUndefined();
  });
});

describe("a damaged stored pass (MEM-7)", () => {
  it("is read as not checked yet, never as a pass with missing fields", () => {
    const write = (value: unknown): void => writeFileSync(path.join(dir, CANARY_STATE_FILE), JSON.stringify(value));
    write({ status: "passed" });
    expect(readCanaryState(dir)).toBeUndefined();
    write({ status: "passed", binary_path: "/x", argv: "k" });
    expect(readCanaryState(dir)).toBeUndefined();
    write({ status: "passed", binary_path: "/x", argv: "k", checked_at: "not a date" });
    expect(readCanaryState(dir)).toBeUndefined();
    write({ status: "passed", binary_path: "/x", argv: 4, checked_at: "2026-10-17T10:00:00.000Z" });
    expect(readCanaryState(dir)).toBeUndefined();
    write({ status: "passed", binary_path: "/x", argv: "k", checked_at: "2026-10-17T10:00:00.000Z", binary_version: "2.1.295" });
    expect(readCanaryState(dir)).toMatchObject({ status: "passed" });
  });
});
