import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StartOptions } from "@fulcrumaxe/runner-protocol";
import { createClaudeEngine, type EngineConfig } from "../../../src/engines/claude/engine.js";
import { protectedPaths } from "../../../src/sandbox/sandboxSettings.js";
import { storedBinarySource } from "../../../src/engines/claude/pin.js";
import { RUN_ID, countingSpawn, fixtureText, makeFake, type Fake } from "./harness.js";

export * from "./harness.js";

/** The least a sandbox block must say for the engine to start: on, strict, no auto-allow. */
export const ON_BLOCK = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false };

export interface Rig {
  fake: Fake;
  root: string;
  workdir: string;
  config: EngineConfig;
  spawns: string[];
  startOptions(over?: Partial<StartOptions>): StartOptions & { events: unknown[] };
}

/** An engine over a fake binary, with every directory under one temporary root and a spawn wrapper that counts calls. */
export function makeRig(over: { fake?: Fake; credentials?: EngineConfig["credentials"]; envOptions?: EngineConfig["envOptions"]; onLocalEvent?: EngineConfig["onLocalEvent"]; sandbox?: Record<string, unknown> } = {}): Rig {
  const fake = over.fake ?? makeFake();
  const root = mkdtempSync(path.join(tmpdir(), "r4b12_rig-"));
  const workdir = path.join(root, "workspace");
  mkdirSync(workdir);
  const { spawn: counting, spawns } = countingSpawn();
  const config: EngineConfig = {
    binary: storedBinarySource({ storedPath: fake.binary, cacheDir: path.join(root, "cache"), spawn: counting }),
    credentials: over.credentials ?? { mode: "subscription" },
    sandboxSettings: over.sandbox ?? ON_BLOCK,
    protectedPaths: protectedPaths({ home: path.join(root, "home"), stateDir: path.join(root, "home", ".fx-runner"), binaryDir: path.dirname(fake.binary) }),
    jobsDir: path.join(root, "jobs"),
    logDir: path.join(root, "logs"),
    sessionsFile: path.join(root, "sessions.json"),
    spawn: counting,
    ...(over.onLocalEvent === undefined ? {} : { onLocalEvent: over.onLocalEvent }),
    ...(over.envOptions === undefined ? {} : { envOptions: over.envOptions }),
  };
  return {
    fake,
    root,
    workdir,
    config,
    spawns,
    startOptions(more = {}) {
      const events: unknown[] = [];
      return { runId: RUN_ID, role: "executor", roleCard: "card", prompt: "PROMPT-TEXT-FROM-JOB", model: "sonnet", workdir, capUsd: 1, onEvent: (event) => void events.push(event), events, ...more };
    },
  };
}

export function engineFor(rig: Rig) {
  return createClaudeEngine(rig.config);
}

/** The subscription stream with its init line's `apiKeySource` changed. */
export function streamWith(apiKeySource: string, name = "stream.subscription.jsonl"): string {
  return fixtureText(name).replace('"apiKeySource":"none"', `"apiKeySource":${JSON.stringify(apiKeySource)}`);
}
