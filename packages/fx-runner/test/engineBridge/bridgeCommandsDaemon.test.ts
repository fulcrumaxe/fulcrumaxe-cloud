import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineCommand } from "@fulcrumaxe/runner-protocol";
import { createBridgeApply } from "../../src/commands/engineBridge.js";
import { startEngineBridge, type EngineBridge, type EngineBridgePorts } from "../../src/engineBridge/daemon.js";
import { loadBridgeSettings } from "../../src/engineBridge/settings.js";
import { generateRunnerKey } from "../../src/keys.js";
import { manualClock, type ManualClock } from "../helpers/manualClock.js";
import { startFakeCommands, type FakeCommands } from "../helpers/strictEngineCommands.js";

// D#845 ON-BR-2 in the daemon: the runner's own bridge command loop runs with no repo enabled, through the real signed pull, and what it enables then runs like any enabled repo.
const REPO = 77;
const uid = process.getuid?.();
let root: string;
let runnerDir: string;
let home: string;
let cmds: FakeCommands;
let clock: ManualClock;
let bridge: EngineBridge | undefined;
let logs: string[];

const ports = (): EngineBridgePorts => ({
  halt: { handleControl: async () => undefined, readHostHandle: () => undefined, readHaltState: () => undefined },
  ceiling: { create: () => ({ run: async (signal) => clock.sleep(1e9, signal), controlsChanged: () => undefined, status: () => null }) },
});

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "fx-onbr2-daemon-"));
  runnerDir = path.join(root, "runner");
  home = path.join(root, "home");
  mkdirSync(runnerDir, { mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  const checkout = path.join(home, "code", "acme", "widgets");
  const state = path.join(root, "engine-state");
  mkdirSync(path.join(checkout, ".git"), { recursive: true });
  mkdirSync(path.join(checkout, ".autonomous-team"), { recursive: true });
  mkdirSync(path.join(checkout, "engine"), { recursive: true });
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(path.join(checkout, ".git", "config"), `[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n`);
  writeFileSync(path.join(checkout, ".autonomous-team", "project.json"), JSON.stringify({ project_name: "widgets", state_dir: state }));
  writeFileSync(path.join(checkout, "engine", "manifest.json"), JSON.stringify({ engine_version: "1.2.3", files: {} }));
  cmds = await startFakeCommands();
  const key = generateRunnerKey();
  cmds.trust(key.publicJwk);
  clock = manualClock(Date.now());
  cmds.now = () => clock.now();
  cmds.allowedRepos = [{ repo_gh_id: REPO, full_name: "acme/widgets" }];
  logs = [];
  const cloud = { origin: cmds.origin, key, now: () => clock.now(), fetchFn: fetch };
  bridge = startEngineBridge({
    runnerStateDir: runnerDir, uid, clock, runnerVersion: "0.1.1", cloud, keyring: cmds.keyring, runnerId: cmds.runnerId,
    send: async () => ({ kind: "off" }), wakeEpoch: () => null, accepted: () => true, xdgRuntimeDir: undefined, secrets: () => [], ports: ports(), log: (l) => logs.push(l),
    bridgeApply: createBridgeApply({ stateDir: runnerDir, uid, now: () => clock.now(), options: { home, engineStateDirOverride: undefined, discovery: { cwd: undefined, searchRoots: undefined } } }),
  });
});
afterEach(async () => {
  await bridge?.stop();
  await cmds.close();
  rmSync(root, { recursive: true, force: true });
});

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 80 && !cond(); i++) {
    await clock.advance(1000, 1000);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  for (let since = Date.now(); !cond() && Date.now() - since < 10_000; ) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!cond()) throw new Error("condition never held");
}
const bridgeCommand = (seq: number, kind: "bridge_enable" | "bridge_disable"): EngineCommand => cmds.command(REPO, seq, { kind, args: {} } as Partial<EngineCommand>);

describe("the bridge command loop in the daemon", () => {
  it("pulls with no repo enabled, takes a connect, enables the repo it found, acks the result, and reports what it bridges on the next pull", async () => {
    expect(loadBridgeSettings(runnerDir)).toEqual({ ok: true, repos: [] });
    await until(() => cmds.pulls.some((p) => p.bridge_commands === true));
    expect(cmds.pulls.find((p) => p.bridge_commands === true)).toMatchObject({ repo_gh_ids: [Number.MAX_SAFE_INTEGER], bridged: [] });
    cmds.queue.push(bridgeCommand(1, "bridge_enable"));
    await until(() => cmds.acks.length === 1);
    expect(cmds.acks[0]!.ack).toEqual({ outcome: "applied", result: "connected", root_tail: "acme/widgets" });
    const saved = loadBridgeSettings(runnerDir);
    expect(saved.ok && saved.repos.map((r) => r.full_name)).toEqual(["acme/widgets"]);
    await until(() => cmds.pulls.some((p) => (p.bridged ?? []).length === 1));
    expect(cmds.pulls.find((p) => (p.bridged ?? []).length === 1)!.bridged![0]).toMatchObject({ repo_gh_id: REPO });
    // The engine's own per-repo pull never carried the bridge kinds, and the engine inbox got none.
    cmds.queue.push(bridgeCommand(2, "bridge_disable"));
    await until(() => cmds.acks.length === 2);
    expect(cmds.acks[1]!.ack).toEqual({ outcome: "applied" });
    const after = loadBridgeSettings(runnerDir);
    expect(after.ok && after.repos).toEqual([]);
    expect(logs.join("\n")).not.toContain(home);
  });
});
