import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanEnv } from "../../src/job/cleanEnv.js";
import { CREDENTIAL_FLOOR, assertEnabledSandbox } from "../../src/sandbox/sandboxSettings.js";
import { FakeMessagesApi } from "./fakeMessagesApi.js";
import { buildLayout, judge, passes, plant, probeSteps, productionConfig, scanForNeedles, variants, writeHarnessFiles, type Layout, type Probe } from "./matrix.js";

/** The parts of the B-10 matrix that need no macOS and no CLI: the fake API, the probe list, the verdicts, the config and the workflow. */
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
let scratch: string;
let layout: Layout;
beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "fxb10-unit-"));
  layout = buildLayout(path.join(scratch, "home"), path.join(scratch, "tmp"), path.join(scratch, "out"));
  for (const dir of [layout.workspace, layout.tempDir, layout.ownObjects]) mkdirSync(dir, { recursive: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

const post = async (url: string, body: unknown): Promise<string> => (await fetch(`${url}/v1/messages`, { method: "POST", body: JSON.stringify(body) })).text();
const call = (id: string): { id: string; name: "Bash"; input: Record<string, unknown> } => ({ id, name: "Bash", input: { command: `echo ${id}` } });

describe("the scripted Messages API", () => {
  it("sends each step as one streamed assistant message, the next once every result is in, then ends the turn", async () => {
    const api = new FakeMessagesApi([[call("toolu_a"), call("toolu_b")], [call("toolu_c")]]);
    const url = await api.start();
    try {
      const first = await post(url, { stream: true, tools: [{ name: "Bash" }], messages: [{ role: "user", content: "go" }] });
      expect(first).toContain("event: message_start");
      expect(first.match(/"type":"tool_use"/g)).toHaveLength(2);
      expect(first).toContain('"stop_reason":"tool_use"');
      const results = (ids: string[]): unknown[] => [{ role: "user", content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: `out-${id}`, is_error: id === "toolu_b" })) }];
      const second = await post(url, { stream: true, tools: [{ name: "Bash" }], messages: results(["toolu_a"]) });
      expect(second.match(/"id":"toolu_[ab]"/g)).toHaveLength(2); // still waiting for toolu_b: the same step again
      const third = await post(url, { stream: true, tools: [{ name: "Bash" }], messages: results(["toolu_a", "toolu_b"]) });
      expect(third).toContain('"id":"toolu_c"');
      const last = await post(url, { stream: true, tools: [{ name: "Bash" }], messages: results(["toolu_a", "toolu_b", "toolu_c"]) });
      expect(last).toContain('"stop_reason":"end_turn"');
      expect(api.results.get("toolu_b")).toEqual({ text: "out-toolu_b", isError: true });
      expect(api.nextStep()).toBeUndefined();
    } finally {
      await api.stop();
    }
  });

  it("answers a request without tools, a non-streamed one, a token count and a read with something valid, and logs raw bodies", async () => {
    const api = new FakeMessagesApi([[call("toolu_a")]]);
    const url = await api.start();
    try {
      expect(JSON.parse(await post(url, { messages: [] }))).toMatchObject({ type: "message", stop_reason: "end_turn" });
      expect(JSON.parse(await post(url, { tools: [{ name: "Bash" }], messages: [] }))).toMatchObject({ stop_reason: "tool_use" });
      expect(JSON.parse(await (await fetch(`${url}/v1/messages/count_tokens`, { method: "POST", body: "{}" })).text())).toEqual({ input_tokens: 1 });
      expect(JSON.parse(await (await fetch(`${url}/v1/models`)).text())).toEqual({ data: [], has_more: false });
      expect(api.rawRequests.length).toBeGreaterThanOrEqual(3);
    } finally {
      await api.stop();
    }
  });
});

describe("the sentinels and probes", () => {
  it("plants a sentinel at every credential floor entry and every other protected place", () => {
    const sentinels = plant(layout, "linux");
    for (const entry of CREDENTIAL_FLOOR) expect(sentinels.some((s) => s.floor === entry && s.file.startsWith(path.join(layout.home, entry))), entry).toBe(true);
    expect(sentinels.map((s) => s.id)).toEqual(expect.arrayContaining(["state", "binary", "sibling_workspace", "sibling_temp", "other_mirror"]));
    expect(new Set(sentinels.map((s) => s.text)).size).toBe(sentinels.length);
    expect(readFileSync(sentinels.find((s) => s.id === "npmrc")!.file, "utf8")).toContain(sentinels.find((s) => s.id === "npmrc")!.text);
  });

  it("probes each sentinel through bash, python, Read, Grep, Glob, a symlink and a hard link, with the file-tool link reads after the links are made", () => {
    const sentinels = plant(layout, "linux");
    const [direct, links] = probeSteps(layout, sentinels, "linux");
    for (const s of sentinels.filter((x) => x.info !== true)) {
      const channels = [...direct!, ...links!].filter((p) => p.sentinel === s.id).map((p) => p.channel);
      expect(channels, s.id).toEqual(expect.arrayContaining(["bash_cat", "python_open", "read_tool", "grep_tool", "symlink_bash", "hardlink_bash", "symlink_read_tool", "hardlink_read_tool"]));
      expect(channels.includes("glob_tool"), s.id).toBe(!["netrc", "npmrc", "claude_json"].includes(s.id));
    }
    expect(links!.every((p) => p.call.name === "Read")).toBe(true);
    const ids = [...direct!, ...links!].map((p) => p.call.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(direct!.filter((p) => p.expect === "found" && p.info !== true).map((p) => p.channel)).toEqual(["bash_workspace", "bash_own_mirror", "read_workspace"]);
  });

  it("sends every OS-layer Bash probe through probe.sh, so no command text names a path outside the workspace", () => {
    const sentinels = plant(layout, "linux");
    writeHarnessFiles(layout, sentinels, "linux");
    const osLayer = probeSteps(layout, sentinels, "linux").flat().filter((p) => p.call.name === "Bash" && p.channel !== "direct_cat" && p.channel !== "git_config");
    expect(osLayer.length).toBeGreaterThan(sentinels.length * 3);
    for (const p of osLayer) expect(String(p.call.input.command), p.call.id).toMatch(/^(bash \.\/probe\.sh \w+ [\w:]+|cat readable\.txt)$/);
    const targets = readFileSync(path.join(layout.workspace, "targets.tsv"), "utf8");
    for (const s of sentinels) expect(targets).toContain(`${s.id}\t${s.file}`);
    expect(readFileSync(path.join(layout.workspace, "probe.sh"), "utf8")).toContain("hardlink)");
  });

  it("adds the macOS aliases, the case variant and the Keychain probes on darwin only", () => {
    const mac: Layout = buildLayout("/Users/runner", "/var/folders/xx/T", path.join(scratch, "out"));
    const sentinels = [
      { id: "ssh", file: "/Users/runner/.ssh/fx-s-1", text: "FXSENT-ssh-1", deny: "/Users/runner/.ssh", floor: ".ssh" },
      { id: "sibling_temp", file: path.join(mac.tempRoot, "sibling/fx-s-2"), text: "FXSENT-sibling_temp-2", deny: mac.tempRoot },
    ];
    const keychain = ["aa", "bb"].map((x, i) => `FXSENT-keychain${i}-${x}`);
    const channels = (platform: NodeJS.Platform, kc: string[] = []): string[] => probeSteps(mac, sentinels, platform, kc).flat().map((p) => p.channel);
    expect(channels("linux")).not.toContain("case_variant");
    expect(channels("linux")).not.toContain("alias_data_volume");
    expect(channels("darwin", keychain)).toEqual(expect.arrayContaining(["case_variant", "alias_data_volume", "alias_private_var"]));
    const finds = probeSteps(mac, sentinels, "darwin", keychain).flat().filter((p) => p.channel === "keychain_find");
    expect(finds.map((p) => p.call.input.command)).toEqual(["security find-generic-password -s 'fx-canary' -w", "security find-generic-password -s 'Claude Code-credentials' -w"]);
    expect(variants(mac, sentinels[0]!, "darwin").case_variant).toBe("/Users/runner/.SSH/fx-s-1");
    expect(variants(mac, sentinels[0]!, "darwin").alias_data_volume).toBe("/System/Volumes/Data/Users/runner/.ssh/fx-s-1");
    expect(probeSteps(mac, sentinels, "darwin").flat().find((p) => p.channel === "case_variant")?.call.input.command).toBe("bash ./probe.sh cat ssh:case_variant");
  });
});

describe("verdicts and scans", () => {
  const probe = (expectation: Probe["expect"]): Probe => ({ call: call("toolu_x"), channel: "bash_cat", sentinel: "ssh", needle: "FXSENT-ssh-1", expect: expectation });
  it("judges from the tool result: found when the needle is in it, denied when it is not, unanswered when there is none", () => {
    const api = new FakeMessagesApi([]);
    expect(judge(probe("denied"), api)).toBe("unanswered");
    api.results.set("toolu_x", { text: "Permission denied", isError: true });
    expect(judge(probe("denied"), api)).toBe("denied");
    api.results.set("toolu_x", { text: "FXSENT-ssh-1\n", isError: false });
    expect(judge(probe("denied"), api)).toBe("found");
    expect(passes(probe("denied"), "found")).toBe(false);
    expect(passes(probe("found"), "found")).toBe(true);
    expect(passes(probe("denied"), "unanswered")).toBe(false);
  });
  it("names where a needle was seen without printing it", () => {
    expect(scanForNeedles({ "a.log": "x FXSENT-ssh-1 y", "b.log": "clean" }, ["FXSENT-ssh-1"])).toEqual(["a.log: ssh"]);
  });
});

describe("the production configuration", () => {
  it("comes from the runner's own builders: an enabled sandbox, home denied, the settings file named on the command line", () => {
    const { sandbox, argv } = productionConfig(layout);
    assertEnabledSandbox(sandbox);
    expect((sandbox.filesystem as { denyRead: string[] }).denyRead).toContain(layout.home);
    expect(argv[argv.indexOf("--settings") + 1]).toBe(path.join(layout.jobDir, "settings.json"));
    expect(argv).toContain("--strict-mcp-config");
  });
  it("lets a mutation leave entries out of the one protected list: the sandbox block and the file-tool rules both lose them", () => {
    const { sandbox } = productionConfig(layout, (entry) => entry !== path.join(layout.home, ".ssh") && entry !== layout.home);
    expect((sandbox.filesystem as { denyRead: string[] }).denyRead).not.toContain(layout.home);
    expect((sandbox.credentials as { files: Array<{ path: string }> }).files.map((f) => f.path)).not.toContain(path.join(layout.home, ".ssh"));
    const written = JSON.parse(readFileSync(path.join(layout.jobDir, "settings.json"), "utf8")) as { permissions: { deny: string[]; blockReadsOutsideWorkingDirectories: boolean } };
    expect(written.permissions.blockReadsOutsideWorkingDirectories).toBe(false);
    expect(written.permissions.deny.some((rule) => rule.includes("/.ssh"))).toBe(false);
    expect(written.permissions.deny.some((rule) => rule.includes("/.aws"))).toBe(true);
    productionConfig(layout);
    expect(JSON.parse(readFileSync(path.join(layout.jobDir, "settings.json"), "utf8")).permissions.blockReadsOutsideWorkingDirectories).toBe(true);
  });
  it("B-10.5: production refuses a base URL in a job's environment, whether the host sets it or the job asks for it", () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "http://127.0.0.1:9");
    expect(cleanEnv({ mode: "api_key", apiKey: "k" })).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(() => cleanEnv({ mode: "api_key", apiKey: "k" }, { jobEnv: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" } })).toThrow(/not an allowed per-job variable/);
  });
});

describe("the workflow", () => {
  const text = readFileSync(path.join(REPO, ".github/workflows/macos-sandbox-check.yml"), "utf8");
  type Job = { if: string; "runs-on": string; "timeout-minutes": number; steps: Array<{ uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }> };
  const doc = load(text) as { on: Record<string, unknown>; permissions: unknown; jobs: Record<string, Job> };
  const jobs = Object.values(doc.jobs);
  it("starts only by hand, reads only, holds no secret and runs only on the public plane", () => {
    expect(Object.keys(doc.on)).toEqual(["workflow_dispatch"]);
    expect(doc.on.workflow_dispatch ?? null).toBeNull();
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(text.replace(/^\s*#.*$/gm, "")).not.toMatch(/secrets\.|inputs\./);
    for (const job of jobs) {
      expect(job.if).toBe("vars.CI_DISABLED != 'true' && github.event.repository.private == false");
      expect(job["timeout-minutes"]).toBeLessThanOrEqual(45);
    }
  });
  it("covers the Apple-silicon, Intel and Linux hosted runners by literal label, every action pinned by full sha, and sets the opt-in the tests need", () => {
    expect(jobs.map((j) => j["runs-on"])).toEqual(["macos-15", "macos-15-intel", "ubuntu-24.04"]);
    for (const job of jobs) {
      for (const step of job.steps) if (step.uses !== undefined) expect(step.uses, step.uses).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40}$/);
      expect(job.steps.find((s) => s.uses?.startsWith("actions/checkout"))?.with).toEqual({ "persist-credentials": false });
      expect(job.steps.some((s) => s.env?.FX_B10 === "1" && /vitest run test\/canary/.test(s.run ?? ""))).toBe(true);
      expect(job.steps.some((s) => /MIN_CLAUDE_VERSION/.test(s.run ?? ""))).toBe(true);
    }
  });
});
