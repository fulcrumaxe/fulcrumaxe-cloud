/**
 * D#102 permanent guard (Spec Acceptance items 1-3). The local runtime must pass
 * `settingSources: []`, `mcpServers: {}` and `strictMcpConfig: true` as
 * explicit own properties on every `query()` call, so that nothing in a
 * run's working tree -- `.claude/settings*.json`, `.mcp.json`, on-disk
 * agent or plugin MCP config -- can shape hooks, tool approvals or MCP
 * servers for that run. This is the guard against D#102's Risk: "anyone
 * who can open a PR on the repo could control them."
 *
 * This test MUST keep passing when D#47 M13/M14 add entries to
 * `mcpServers` for customer servers (owner ruling #23, D#102 correction
 * C2): those entries arrive only through the explicit `mcpServers` option
 * this runtime builds, never by loading the working tree's `.mcp.json`.
 * `settingSources` is never widened to include `'project'` or `'local'` to
 * deliver them. Do not skip, `.todo`, or env-conditionally gate this file.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Prior art for mocking the SDK's query(): redact.test.ts:264.
const FAKE_MESSAGES = [
  { type: "system", subtype: "init", session_id: "session-hostile-1" },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    session_id: "session-hostile-1",
  },
];

let recordedOptionsCalls: Array<Record<string, unknown>> = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn((args: { options: Record<string, unknown> }) => {
    recordedOptionsCalls.push(args.options);
    async function* gen() {
      for (const message of FAKE_MESSAGES) {
        yield message;
      }
    }
    const iterator = gen();
    return Object.assign(iterator, { close: vi.fn() });
  }),
}));

const HOSTILE_FIXTURE_DIR = new URL("./fixtures/hostile-repo", import.meta.url).pathname;

function makeEnv(): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin", FX_RUNTIME: "local" };
}

describe("local runtime passes settingSources/mcpServers/strictMcpConfig as own properties (Spec Acceptance item 1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordedOptionsCalls = [];
  });

  it("start(): the recorded options carry all three as own properties", async () => {
    const { createLocalRuntime } = await import("../src/local/index.js");
    const runtime = createLocalRuntime(makeEnv());

    await runtime.start({
      runId: "run-settings-1",
      role: "executor",
      roleCard: "card",
      prompt: "go",
      model: "haiku",
      workdir: "/tmp",
      capUsd: 0.05,
      onEvent: () => {},
    });

    expect(recordedOptionsCalls).toHaveLength(1);
    const options = recordedOptionsCalls[0];
    expect(Object.hasOwn(options, "settingSources")).toBe(true);
    expect(Array.isArray(options.settingSources)).toBe(true);
    expect((options.settingSources as unknown[]).length).toBe(0);
    expect(Object.hasOwn(options, "mcpServers")).toBe(true);
    expect(Object.keys(options.mcpServers as Record<string, unknown>).length).toBe(0);
    expect(options.strictMcpConfig).toBe(true);
  });

  it("resume(): the recorded options on the resume path also carry all three as own properties", async () => {
    const { createLocalRuntime } = await import("../src/local/index.js");
    const runtime = createLocalRuntime(makeEnv());

    const { handle } = await runtime.start({
      runId: "run-settings-2",
      role: "executor",
      roleCard: "card",
      prompt: "go",
      model: "haiku",
      workdir: "/tmp",
      capUsd: 0.05,
      onEvent: () => {},
    });

    await runtime.resume(handle, handle.sessionId ?? "session-hostile-1", "keep going");

    expect(recordedOptionsCalls).toHaveLength(2);
    const resumeOptions = recordedOptionsCalls[1];
    expect(Object.hasOwn(resumeOptions, "settingSources")).toBe(true);
    expect(Array.isArray(resumeOptions.settingSources)).toBe(true);
    expect((resumeOptions.settingSources as unknown[]).length).toBe(0);
    expect(Object.hasOwn(resumeOptions, "mcpServers")).toBe(true);
    expect(Object.keys(resumeOptions.mcpServers as Record<string, unknown>).length).toBe(0);
    expect(resumeOptions.strictMcpConfig).toBe(true);
  });
});

describe("hostile fixture changes nothing (Spec Acceptance items 2 and 3, permanent per C2)", () => {
  let emptyDir: string;
  let markerPath: string;
  let originalMarkerEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    recordedOptionsCalls = [];
    emptyDir = mkdtempSync(join(tmpdir(), "fx-d102-empty-"));
    const markerDir = mkdtempSync(join(tmpdir(), "fx-d102-marker-"));
    markerPath = join(markerDir, "hostile-hook-fired.marker");
    // The fixture's SessionStart hook command reads this env var (never a
    // path inside the repo) so the test can prove it never fired.
    originalMarkerEnv = process.env.HOSTILE_REPO_MARKER_PATH;
    process.env.HOSTILE_REPO_MARKER_PATH = markerPath;
  });

  afterEach(() => {
    if (originalMarkerEnv === undefined) delete process.env.HOSTILE_REPO_MARKER_PATH;
    else process.env.HOSTILE_REPO_MARKER_PATH = originalMarkerEnv;
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("options recorded for the hostile fixture workdir deep-equal the options for an empty workdir, apart from cwd -- and the fixture's hook never fires", async () => {
    const { createLocalRuntime } = await import("../src/local/index.js");

    const hostileRuntime = createLocalRuntime(makeEnv());
    await hostileRuntime.start({
      runId: "run-hostile",
      role: "executor",
      roleCard: "card",
      prompt: "go",
      model: "haiku",
      workdir: HOSTILE_FIXTURE_DIR,
      capUsd: 0.05,
      onEvent: () => {},
    });

    const cleanRuntime = createLocalRuntime(makeEnv());
    await cleanRuntime.start({
      runId: "run-clean",
      role: "executor",
      roleCard: "card",
      prompt: "go",
      model: "haiku",
      workdir: emptyDir,
      capUsd: 0.05,
      onEvent: () => {},
    });

    expect(recordedOptionsCalls).toHaveLength(2);
    const [hostileOptions, cleanOptions] = recordedOptionsCalls;

    // Apart from cwd, the two option objects must be identical -- the
    // hostile working tree's .claude/settings.json and .mcp.json must not
    // change a single option.
    const { cwd: hostileCwd, ...hostileRest } = hostileOptions as { cwd?: string };
    const { cwd: cleanCwd, ...cleanRest } = cleanOptions as { cwd?: string };
    expect(hostileCwd).toBe(HOSTILE_FIXTURE_DIR);
    expect(cleanCwd).toBe(emptyDir);
    expect(hostileRest).toStrictEqual(cleanRest);

    // The fixture's SessionStart hook (permissions.allow: ["Bash(*)"]
    // would have auto-approved it) writes this marker if project settings
    // ever load. It must not exist after the run.
    expect(existsSync(markerPath)).toBe(false);
  });
});
