import path from "node:path";
import type { EngineKit } from "../../daemon/engineKit.js";
import { cleanEnv } from "../../job/cleanEnv.js";
import { runCapture, runForeground, type SpawnFn } from "./capture.js";
import { authState } from "./authStatus.js";
import { createClaudeEngine } from "./engine.js";
import { MIN_CLAUDE_VERSION, inspectBinary, resolveClaudePath, storedBinarySource, versionSupported } from "./pin.js";
import { planSession, readSessionIndex, recordSession } from "./session.js";
import { takeoverCommand } from "./takeover.js";

/** The kit for the user's installed Claude Code CLI. `spawnFn` is the real process start, handed in by the program's entry point. */
export function createClaudeKit(spawnFn: SpawnFn): EngineKit {
  const starter = { spawn: spawnFn };
  const sessionsFile = (stateDir: string): string => path.join(stateDir, "sessions.json");
  return {
    locate: resolveClaudePath,
    inspect: async (input) => {
      const env = cleanEnv({ mode: "subscription" }, input.envOptions);
      const binary = await inspectBinary({ storedPath: input.binaryPath, cacheDir: input.stateDir, spawn: spawnFn }, env);
      const login = input.loginMode === undefined ? { state: "unknown" as const } : await authState(input.loginMode, { binaryPath: input.binaryPath, env, spawn: spawnFn });
      return {
        version: binary.version,
        minimumVersion: MIN_CLAUDE_VERSION,
        versionSupported: binary.version !== undefined && versionSupported(binary.version),
        missingFlags: binary.missingFlags,
        login: login.state,
        ...(login.authMethod === undefined ? {} : { authMethod: login.authMethod }),
      };
    },
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
    // The first 2 K of error output is kept too: path A reads the proxy's HTTP status from it (never logged or sent).
    capture: (command, args, env, timeoutMs) => runCapture(starter.spawn, command, args, env, timeoutMs, undefined, 2048),
    foreground: (command, args, env) => runForeground(starter.spawn, command, args, env),
    takeOver(input) {
      const { argv, cwd } = takeoverCommand(input);
      return runForeground(starter.spawn, input.binaryPath, argv, cleanEnv(input.credentials, input.envOptions), cwd);
    },
    captureWithStderr: async (command, args, env, timeoutMs) => {
      const out = await runCapture(starter.spawn, command, args, env, timeoutMs, 4096, 4096);
      return { code: out.code, stdout: out.stdout, stderr: out.stderr ?? "", timedOut: out.timedOut };
    },
  };
}
