import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { findOnPath } from "../helpers/findOnPath.js";
import { tempDir } from "../helpers/tempTree.js";
import { SPIKE_DELAY_S, SPIKE_MARGIN_S, SPIKE_SCRIPT, SPIKE_SETTINGS, SPIKE_TOUCH, judgeSpike, spikePrompt } from "./helpers/engineSpike.js";

/**
 * D#845 ON-13b1 spike gate, with a FAKE model: the harness script and the judge run end to end against a stand-in host that behaves the two possible ways (the background worker outlives the turn, or it is
 * stopped with it). The real model is never started: the stand-in is a Node script, the child gets a private PATH that holds python3 and nothing else, and the test asserts that the real `claude`, `gh` and
 * any `git-credential-*` are unreachable on it before the first start. The real run is `engineSpike.real.test.ts`, which the Team Lead runs by hand.
 */
const run = promisify(execFile);
const DELAY_S = 3;
const MARGIN_S = 1;
const HOLD_S = 9;
const FIXED_ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];

const standIn = (): string => `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const mode = process.env.FAKE_MODE, marker = process.env.FAKE_MARKER;
const fixed = ${JSON.stringify(FIXED_ARGS)};
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(fixed)) { process.stderr.write("unexpected arguments\\n"); process.exit(2); }
const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "", turned = false;
process.stdin.on("data", (d) => {
  buf += d;
  if (turned || !buf.includes("\\n")) return;
  turned = true;
  say({ type: "system", subtype: "init", session_id: "00000000-0000-4000-8000-000000000001" });
  if (mode === "exit") process.exit(1);
  const worker = spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.env.FAKE_MARKER, 'done'), ${DELAY_S * 1000})"], { detached: true, stdio: "ignore", env: process.env });
  worker.unref();
  say({ type: "result", subtype: mode === "error" ? "error_during_execution" : "success", is_error: mode === "error", permission_denials: mode === "denied" ? [{ tool_name: "Agent" }] : [], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 }, modelUsage: { "fake-haiku": {} } });
  if (mode === "lost") process.kill(worker.pid, "SIGKILL");
});
process.stdin.on("end", () => process.exit(0));
`;

async function harness(mode: string): Promise<string> {
  const dir = tempDir("fxr-spike-");
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const python = findOnPath("python3", process.env["PATH"] ?? "");
  expect(python, "python3 is needed for the harness script").toBeDefined();
  symlinkSync(python as string, path.join(bin, "python3"));
  // the real claude, gh and credential helpers are unreachable on the child's PATH, and a missing tool is a missing tool
  for (const name of ["claude", "gh", "git", "git-credential-store", "git-credential-cache", "git-credential-manager"]) expect(findOnPath(name, bin)).toBeUndefined();
  expect(readdirSync(bin)).toEqual(["python3"]);
  const fake = path.join(dir, "fake-host");
  writeFileSync(fake, standIn());
  chmodSync(fake, 0o755);
  const script = path.join(dir, "engineSpike.py");
  writeFileSync(script, SPIKE_SCRIPT);
  const prompt = path.join(dir, "prompt.txt");
  writeFileSync(prompt, spikePrompt());
  const marker = path.join(dir, "marker.txt");
  const { stdout } = await run(path.join(bin, "python3"), [script, fake, prompt, marker, String(HOLD_S), "fake-haiku"], { env: { PATH: bin, HOME: dir, FAKE_MODE: mode, FAKE_MARKER: marker }, timeout: 60_000 });
  return stdout;
}

describe("the spike harness and its judge, against a fake model", () => {
  it("survived: the worker writes its marker after the turn ended, and the report carries the model and the usage totals", { timeout: 60_000 }, async () => {
    const out = await harness("survive");
    expect(out).toMatch(/^X 0$/m);
    const report = judgeSpike(out, MARGIN_S);
    expect(report).toMatchObject({ verdict: "survived", reason: "marker_after_turn", turns: 1, models: ["fake-haiku"], usage: { input: 10, output: 5, cache_read: 100, cache_write: 7 } });
    expect(report.marker_after_turn_s).toBeGreaterThanOrEqual(MARGIN_S);
  });

  it("lost: a worker stopped with the turn leaves no marker", { timeout: 60_000 }, async () => {
    const report = judgeSpike(await harness("lost"), MARGIN_S);
    expect(report).toMatchObject({ verdict: "lost", reason: "no_marker", turns: 1 });
  });

  it("inconclusive, never lost: a permission denial, an error turn and a host that exits before any result", { timeout: 120_000 }, async () => {
    expect(judgeSpike(await harness("denied"), MARGIN_S)).toMatchObject({ verdict: "inconclusive", reason: "permission_denied" });
    expect(judgeSpike(await harness("error"), MARGIN_S)).toMatchObject({ verdict: "inconclusive", reason: "turn_error" });
    expect(judgeSpike(await harness("exit"), MARGIN_S)).toMatchObject({ verdict: "inconclusive", reason: "host_exit_early", turns: 0 });
  });

  it("a refusal in a LATER turn is inconclusive with the tool name, two turns with no marker are inconclusive, and a marker after the first turn survives", () => {
    const first = `L 100.000 {"type":"result","is_error":false,"permission_denials":[]}`;
    const late = `L 130.500 {"type":"result","is_error":false,"permission_denials":[{"tool_name":"Bash","tool_input":{"command":"secret text"}},{"tool_name":"bad name!"}]}`;
    const refusedLate = judgeSpike(`${first}\n${late}\nM none\nX 0\n`);
    expect(refusedLate).toMatchObject({ verdict: "inconclusive", reason: "permission_denied", turns: 2, turn_s: [0, 30.5], refused: ["Bash"] });
    expect(JSON.stringify(refusedLate)).not.toContain("secret");
    const plain = `L 130.500 {"type":"result","is_error":false}`;
    expect(judgeSpike(`${first}\n${plain}\nM none\nX 0\n`)).toMatchObject({ verdict: "inconclusive", reason: "second_turn_no_marker", turns: 2, refused: [] });
    expect(judgeSpike(`${first}\n${plain}\nM ${100 + SPIKE_MARGIN_S + 5}\nX 0\n`)).toMatchObject({ verdict: "survived", reason: "marker_after_turn", turns: 2 });
  });

  it("the judge reads nothing but its fixed grammar: junk, a missing tail and a marker just before the turn's end", () => {
    expect(judgeSpike("")).toMatchObject({ verdict: "inconclusive", reason: "unreadable" });
    expect(judgeSpike("L 1.000 not json\nL 2.000 {\"type\":\"result\"}\nM none\nX 0\n")).toMatchObject({ verdict: "lost", reason: "no_marker", turns: 1 });
    expect(judgeSpike(`L 100.000 {"type":"result","is_error":false}\nM ${100 + SPIKE_MARGIN_S - 1}\nX 0\n`)).toMatchObject({ verdict: "lost", reason: "marker_before_turn" });
    expect(judgeSpike(`L 100.000 {"type":"result","is_error":false}\nM ${100 + SPIKE_MARGIN_S}\nX 0\n`)).toMatchObject({ verdict: "survived" });
  });

  it("the real run's prompt and settings name only the tools the spike needs, and no permission-skipping flag appears anywhere in the harness", () => {
    expect(spikePrompt()).toContain(`sleep ${SPIKE_DELAY_S}`);
    expect(spikePrompt()).toContain(`\`${SPIKE_TOUCH}\``);
    expect(JSON.parse(SPIKE_SETTINGS).permissions.allow).toEqual(["Agent", `Bash(sleep ${SPIKE_DELAY_S})`, `Bash(${SPIKE_TOUCH})`]);
    expect(Object.keys(JSON.parse(SPIKE_SETTINGS).permissions)).toEqual(["allow"]);
    expect(SPIKE_SCRIPT).not.toMatch(/permission|dangerous|bypass|allowed-?tools/i);
  });
});
