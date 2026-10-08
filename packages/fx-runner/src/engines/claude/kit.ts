import path from "node:path";
import type { EngineKit } from "../../daemon/engineKit.js";
import { runCapture, type SpawnFn } from "./capture.js";
import { createClaudeEngine } from "./engine.js";
import { resolveClaudePath, storedBinarySource } from "./pin.js";
import { planSession, readSessionIndex, recordSession } from "./session.js";

/** The kit for the user's installed Claude Code CLI. `spawnFn` is the real process start, handed in by the program's entry point. */
export function createClaudeKit(spawnFn: SpawnFn): EngineKit {
  const starter = { spawn: spawnFn };
  const sessionsFile = (stateDir: string): string => path.join(stateDir, "sessions.json");
  return {
    locate: resolveClaudePath,
    makeRuntime: (input) =>
      createClaudeEngine({
        binary: storedBinarySource({ storedPath: input.binaryPath, cacheDir: input.stateDir, spawn: spawnFn }),
        credentials: input.credentials,
        envOptions: input.envOptions,
        sandboxSettings: input.sandboxSettings,
        protectedPaths: input.protectedPaths,
        jobsDir: path.join(input.stateDir, "jobs"),
        logDir: path.join(input.stateDir, "logs"),
        sessionsFile: sessionsFile(input.stateDir),
        spawn: spawnFn,
        onLocalEvent: input.onLocalEvent,
      }),
    planSession: (stateDir, continues) => planSession(continues, readSessionIndex(sessionsFile(stateDir))),
    recordSession: (stateDir, sessionId, workspace) => recordSession(sessionsFile(stateDir), sessionId, workspace),
    capture: (command, args, env, timeoutMs) => runCapture(starter.spawn, command, args, env, timeoutMs),
  };
}
