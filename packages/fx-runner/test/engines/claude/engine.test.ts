import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LocalOnlyEvent } from "@fulcrumaxe/runner-protocol";
import { outcomeOf } from "../../../src/engines/claude/engine.js";
import { storedBinarySource } from "../../../src/engines/claude/pin.js";
import { FULL_HELP, ON_BLOCK, RUN_ID, helpWithout, authText, engineFor, makeFake, makeRig, streamWith } from "./rig.js";

describe("engine preflight: each refusal happens before the job's process exists", () => {
  it("a stored path that is gone is claude_binary_missing with zero spawns", async () => {
    const rig = makeRig();
    rig.config.binary = storedBinarySource({ storedPath: path.join(rig.root, "gone"), cacheDir: path.join(rig.root, "cache"), spawn: rig.config.spawn! });
    await expect(engineFor(rig).start(rig.startOptions())).rejects.toMatchObject({ code: "claude_binary_missing" });
    expect(rig.spawns).toEqual([]);
  });

  it("a version below the minimum is refused with an upgrade hint, before the login question", async () => {
    const rig = makeRig({ fake: makeFake({ version: "2.1.258 (Claude Code)" }) });
    await expect(engineFor(rig).start(rig.startOptions())).rejects.toMatchObject({ code: "claude_version_unsupported", message: expect.stringContaining("upgrade") });
    expect(rig.fake.calls()).toEqual(["--version "]);
  });

  it("a custom BinarySource that reports a version below the minimum is refused by the engine itself, with no spawn", async () => {
    const rig = makeRig();
    rig.config.binary = async () => ({ path: rig.fake.binary, version: "2.1.258" });
    await expect(engineFor(rig).start(rig.startOptions())).rejects.toMatchObject({ code: "claude_version_unsupported", message: expect.stringContaining("upgrade") });
    expect(rig.spawns).toEqual([]);
  });

  it("a build whose --help lacks a flag is refused, naming it, before the login question and any model run", async () => {
    const rig = makeRig({ fake: makeFake({ help: helpWithout(FULL_HELP, "--permission-prompts") }) });
    await expect(engineFor(rig).start(rig.startOptions())).rejects.toMatchObject({ code: "claude_flags_unsupported", message: expect.stringContaining("--permission-prompts") });
    expect(rig.fake.calls()).toEqual(["--version ", "--help "]);
  });

  it("no login of the right kind is auth_missing: one login question, no model run", async () => {
    const rig = makeRig({ fake: makeFake({ auth: authText("auth.none.json") }) });
    await expect(engineFor(rig).start(rig.startOptions())).rejects.toMatchObject({ code: "auth_missing" });
    expect(rig.fake.calls()).toEqual(["--version ", "--help ", "auth status"]);
  });

  it("a block the sandbox guard refuses is bad_start_options before any spawn: auto-allow on, no fail-closed flag, or empty", async () => {
    for (const sandbox of [{ ...ON_BLOCK, autoAllowBashIfSandboxed: true }, { ...ON_BLOCK, failIfUnavailable: false }, { enabled: true }, {}]) {
      const rig = makeRig({ sandbox });
      await expect(engineFor(rig).start(rig.startOptions())).rejects.toMatchObject({ code: "bad_start_options" });
      expect(rig.spawns).toEqual([]);
    }
  });

  it("an unknown role is refused before any spawn", async () => {
    const rig = makeRig();
    await expect(engineFor(rig).start(rig.startOptions({ role: "constructor" }))).rejects.toMatchObject({ code: "unknown_role" });
    expect(rig.spawns).toEqual([]);
  });
});

describe("engine run", () => {
  it("no job text and no credential in argv, the prompt on stdin, the settings file 0600", async () => {
    const rig = makeRig({ credentials: { mode: "api_key", apiKey: "sk-test-config-key-value" } });
    rig.fake.set("auth.json", JSON.stringify({ authMethod: "api_key" }));
    rig.fake.set("stream.jsonl", streamWith("ANTHROPIC_API_KEY"));
    const { handle } = await engineFor(rig).start(rig.startOptions());
    expect((await outcomeOf(handle)).status).toBe("ok");
    const argv = rig.fake.argv();
    expect(argv.join(" ")).not.toContain("PROMPT-TEXT-FROM-JOB");
    expect(argv.join(" ")).not.toContain("sk-test-config-key-value");
    expect(rig.fake.stdin()).toBe("PROMPT-TEXT-FROM-JOB");
    expect(statSync(argv[argv.indexOf("--settings") + 1]!).mode & 0o777).toBe(0o600);
  });

  it("a fresh run and a resume write the same settings bytes, and the resume passes --resume", async () => {
    const rig = makeRig();
    const engine = engineFor(rig);
    const file = path.join(rig.config.jobsDir, RUN_ID, "settings.json");
    const first = await engine.start(rig.startOptions());
    await outcomeOf(first.handle);
    const fresh = readFileSync(file, "utf8");
    const second = await engine.resume(first.handle, "sess-0001", "next prompt");
    await outcomeOf(second.handle);
    expect(readFileSync(file, "utf8")).toBe(fresh);
    expect(rig.fake.argv().slice(-2)).toEqual(["--resume", "sess-0001"]);
    expect(rig.fake.stdin()).toBe("next prompt");
  });

  it("the version is on the run: in the outcome, the local log and the first uploaded event", async () => {
    const local: LocalOnlyEvent[] = [];
    const rig = makeRig({ onLocalEvent: (event) => void local.push(event) });
    const { handle } = await engineFor(rig).start(rig.startOptions());
    expect((await outcomeOf(handle)).engineVersion).toBe("2.1.294");
    expect(local[0]).toMatchObject({ seq: 0, type: "engine_version", engine_version: "2.1.294" });
    const records = readFileSync(path.join(rig.config.logDir, `${RUN_ID}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { kind: string; line: string });
    expect(records[0]).toEqual({ kind: "meta", line: '{"engine_version":"2.1.294"}' });
  });

  it("backstop: an unknown-option exit before the init line is claude_flags_unsupported, with nothing processed and no generic failure", async () => {
    const local: LocalOnlyEvent[] = [];
    const rig = makeRig({ onLocalEvent: (event) => void local.push(event) });
    rig.fake.set("unknown-option", "1");
    const opts = rig.startOptions();
    const { handle } = await engineFor(rig).start(opts);
    expect(await outcomeOf(handle)).toEqual({ status: "failed", failureReason: "claude_flags_unsupported", engineVersion: "2.1.294" });
    expect(opts.events).toEqual([]);
    expect(local.map((event) => event.type)).toEqual(["engine_version"]);
  });

  it("passes no permission mode and declares the settings file's allow rules as --allowedTools, so the CLI has nothing to override", async () => {
    const rig = makeRig();
    const { handle } = await engineFor(rig).start(rig.startOptions());
    expect((await outcomeOf(handle)).status).toBe("ok");
    const argv = rig.fake.argv();
    expect(argv).not.toContain("--permission-mode");
    const settings = JSON.parse(readFileSync(argv[argv.indexOf("--settings") + 1]!, "utf8")) as { permissions: { allow: string[] } };
    expect(argv.slice(argv.indexOf("--allowedTools") + 1, argv.indexOf("--disallowedTools"))).toEqual(settings.permissions.allow);
    expect(settings.permissions.allow.some((rule) => rule.startsWith(`Edit(//${rig.workdir.slice(1)}`))).toBe(true);
  });

  // The text is the CLI 2.1.294's own (read from the binary), including the warning sign it prefixes.
  const FORCED = "⚠ Permission mode forced to default — CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is set (allowed_non_write_users hardening). Declare allowedTools explicitly, or set CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0 to opt out.\n";

  it("fails closed when the CLI says it forced the permission mode: the run is stopped and reported as permission_mode_forced", async () => {
    const local: LocalOnlyEvent[] = [];
    const rig = makeRig({ onLocalEvent: (event) => void local.push(event) });
    rig.fake.set("stderr-first.txt", FORCED);
    rig.fake.set("hang", "1");
    const { handle } = await engineFor(rig).start(rig.startOptions());
    expect(await outcomeOf(handle)).toEqual({ status: "failed", failureReason: "permission_mode_forced", engineVersion: "2.1.294" });
    const child = handle.child as { exitCode: number | null; signalCode: string | null };
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("matches the warning split across two chunks of stderr", async () => {
    const rig = makeRig();
    rig.fake.set("stderr-first.txt", FORCED.slice(0, 20));
    rig.fake.set("stderr.txt", FORCED.slice(20));
    rig.fake.set("hang", "1");
    const { handle } = await engineFor(rig).start(rig.startOptions());
    expect((await outcomeOf(handle)).failureReason).toBe("permission_mode_forced");
  });

  it("the sandbox tools' directories are on the PATH the agent is started with, after the host's own entries", async () => {
    const rig = makeRig({ envOptions: { extraPathDirs: ["/nix/store/aaa-bubblewrap/bin", "/nix/store/bbb-socat/bin"] } });
    const { handle } = await engineFor(rig).start(rig.startOptions());
    expect((await outcomeOf(handle)).status).toBe("ok");
    const pathLine = rig.fake.envText().split("\n").find((line) => line.startsWith("PATH="))!;
    expect(pathLine.endsWith(":/nix/store/aaa-bubblewrap/bin:/nix/store/bbb-socat/bin")).toBe(true);
  });

  it("an unknown-option message after the init line is not the flag backstop: the run had started", async () => {
    const rig = makeRig();
    rig.fake.set("stderr.txt", "error: unknown option '--x'\n");
    rig.fake.set("exit-code", "1");
    const { handle } = await engineFor(rig).start(rig.startOptions());
    expect((await outcomeOf(handle)).failureReason).not.toBe("claude_flags_unsupported");
  });
});
