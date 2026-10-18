import path from "node:path";
import type { EngineKit } from "../../daemon/engineKit.js";
import { cleanEnv, type CleanEnvOptions, type CredentialMode } from "../../job/cleanEnv.js";
import { runCapture, runForeground, runInstall, type SpawnFn } from "./capture.js";
import { authState } from "./authStatus.js";
import { createClaudeEngine } from "./engine.js";
import { type InstructionCanaryResult, guardJobBuild } from "../../instructionCanaryState.js";
import { canaryArgvFingerprint, runInstructionCanary } from "./instructionCanary.js";
import { EngineRefusal } from "./refusal.js";
import { type BinarySource, MIN_CLAUDE_VERSION, inspectBinary, resolveClaudePath, storedBinarySource, versionSupported } from "./pin.js";
import { planSession, readSessionIndex, recordSession } from "./session.js";
import { sessionOfRun, takeoverCommand } from "./takeover.js";

/**
 * D#601 MEM-7 (CWE-367): the binary source of a job when the instruction-file check is on. Each job compares the build it is about to run with the
 * build the stored pass describes. A different build (an in-place CLI update under the running daemon) refuses the job unstarted, holds claiming
 * and runs the check again for the new build; a pass lets later jobs and claims go on.
 */
export function canaryGuardedSource(input: { binaryPath: string; stateDir: string }, base: BinarySource, check: () => Promise<InstructionCanaryResult>): BinarySource {
  return async (env) => {
    const binary = await base(env);
    const blocked = await guardJobBuild({
      stateDir: input.stateDir,
      binaryPath: input.binaryPath,
      binaryVersion: binary.version,
      argv: canaryArgvFingerprint(),
      now: () => new Date(),
      check,
    });
    if (blocked !== undefined) throw new EngineRefusal("claude_version_unsupported", `the Claude Code build (${binary.version}) is not the one the instruction-file check passed on; no job is claimed until the check passes again (${blocked})`);
    return binary;
  };
}

/** The kit for the user's installed Claude Code CLI. `spawnFn` is the real process start, handed in by the program's entry point. */
export function createClaudeKit(spawnFn: SpawnFn, options: { instructionCanary?: boolean } = {}): EngineKit {
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
    // D#601 MEM-7: one model turn at the start of `run`, so only the program's entry point turns it on (the tests that count spawns do not).
    ...(options.instructionCanary === true
      ? {
          instructionCanary: (input: { binaryPath: string; credentials: CredentialMode; envOptions: CleanEnvOptions }) => runInstructionCanary({ binaryPath: input.binaryPath, env: cleanEnv(input.credentials, input.envOptions), spawn: spawnFn }),
          instructionCanaryKey: canaryArgvFingerprint,
        }
      : {}),
    makeRuntime: (input) =>
      createClaudeEngine({
        binary: options.instructionCanary === true
          ? canaryGuardedSource(input, storedBinarySource({ storedPath: input.binaryPath, cacheDir: input.stateDir, spawn: spawnFn }), () => runInstructionCanary({ binaryPath: input.binaryPath, env: cleanEnv(input.credentials, input.envOptions), spawn: spawnFn }))
          : storedBinarySource({ storedPath: input.binaryPath, cacheDir: input.stateDir, spawn: spawnFn }),
        credentials: input.credentials,
        envOptions: input.jobEnv === undefined ? input.envOptions : { ...input.envOptions, jobEnv: input.jobEnv },
        sandboxSettings: input.sandboxSettings,
        protectedPaths: input.protectedPaths,
        jobsDir: path.join(input.stateDir, "jobs"),
        logDir: path.join(input.stateDir, "logs"),
        sessionsFile: sessionsFile(input.stateDir),
        spawn: spawnFn,
        ...(input.limits === undefined ? {} : { limits: input.limits }),
        onLocalEvent: input.onLocalEvent,
        ...(input.onNearLimit === undefined ? {} : { onNearLimit: input.onNearLimit }),
      }),
    planSession: (stateDir, continues) => planSession(continues, readSessionIndex(sessionsFile(stateDir))),
    recordSession: (stateDir, sessionId, workspace) => recordSession(sessionsFile(stateDir), sessionId, workspace),
    sessionOfRun: (stateDir, runId) => sessionOfRun(path.join(stateDir, "logs", `${runId}.jsonl`)),
    // The first 2 K of error output is kept too: path A reads the proxy's HTTP status from it (never logged or sent).
    capture: (command, args, env, timeoutMs) => runCapture(starter.spawn, command, args, env, timeoutMs, undefined, 2048),
    captureLarge: (command, args, env, timeoutMs) => runCapture(starter.spawn, command, args, env, timeoutMs, 8 * 1024 * 1024, 2048),
    installCapture: (command, args, env, cwd, timeoutMs, tailChars, signal) => runInstall(starter.spawn, command, args, env, cwd, timeoutMs, tailChars, signal),
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
