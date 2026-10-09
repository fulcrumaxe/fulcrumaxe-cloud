import { NotAPlainSegment, segmentUnder } from "../../job/plainSegment.js";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { SESSION_ID_PATTERN, normalizeMessage, type AgentHandle, type AgentRuntime, type LocalOnlyEvent, type StartOptions } from "@fulcrumaxe/runner-protocol";
import { assertEnabledSandbox, type ProtectedPaths } from "../../sandbox/sandboxSettings.js";
import { SUBSCRIPTION_TOKEN_VAR, cleanEnv, type CleanEnvOptions, type CredentialMode } from "../../job/cleanEnv.js";
import { UnknownRoleError, roleToolsFor } from "../../job/roleTools.js";
import { claudeArgv } from "./argv.js";
import { confineFileTools } from "./filePermissions.js";
import { authPresent } from "./authStatus.js";
import type { SpawnFn } from "./capture.js";
import { initCredentialMatches, isInitLine } from "./credentialCheck.js";
import { MIN_CLAUDE_VERSION, versionSupported, type BinarySource } from "./pin.js";
import { EngineRefusal } from "./refusal.js";
import { DEFAULT_KILL_GRACE_MS, OWN_PROCESS_GROUP, terminateGroup } from "./processGroup.js";
import { recordSession } from "./session.js";
import { writeJobFiles } from "./settingsFile.js";
import { LineBuffer, createRunLog, projectLocalOnly } from "./stream.js";

/** The job schema types a run id as a uuid, so the engine accepts nothing looser: the id names a directory and a log file. */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLI_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
/**
 * What the CLI writes to stderr when it overrides the permission mode a caller asked for (it does that whenever
 * `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is set and a non-default mode was passed). This engine passes none, so seeing it
 * means a build or an argument list changed under it: the run is stopped and fails closed instead of carrying on with
 * a mode nobody chose.
 */
export const PERMISSION_MODE_FORCED = /permission mode forced to default/i;

export interface EngineConfig {
  /**
   * Where the agent binary comes from, asked before every job. The engine never resolves one itself: v1 passes
   * `storedBinarySource` (the path stored at setup, a minimum version and a flag check); another tier can supply its own.
   */
  binary: BinarySource;
  credentials: CredentialMode;
  /** Extra directories on the agent's PATH (the sandbox tools' own). The job runner and the sandbox tier must be given the same value, or the tier refuses the job's environment. */
  envOptions?: CleanEnvOptions;
  /** The sandbox block of the settings file. It comes from the host sandbox tier's one builder; this engine only writes it. */
  sandboxSettings: Record<string, unknown>;
  /** The protected paths the sandbox tier computed with that block; the settings file's file-tool deny rules come from them. */
  protectedPaths: ProtectedPaths;
  /** Per-job settings files go under here, outside every workspace. */
  jobsDir: string;
  /** `<run>.jsonl` raw transcripts (0600). */
  logDir: string;
  /** The local session index, written when a run ends. */
  sessionsFile: string;
  spawn?: SpawnFn;
  /** How long a stopped agent gets to exit on SIGTERM before everything left in its process group is killed. Default 3000. */
  killGraceMs?: number;
  /** Metadata-only events: the only run output meant for the cloud. */
  onLocalEvent?: (event: LocalOnlyEvent) => void | Promise<void>;
}

/** How a run ended. `failureReason` is a closed code; no model text is ever in it. */
export interface RunOutcome {
  status: "ok" | "failed";
  failureReason?: "credential_mismatch" | "no_init_line" | "claude_flags_unsupported" | "permission_mode_forced" | "agent_error" | "agent_exit";
  /** The agent build the run used. */
  engineVersion: string;
  sessionId?: string;
  agentOutput?: Record<string, unknown>;
}

/** The start options this engine reads. `resumeSessionId` is set by the session planner when a workspace and session are both still there. */
export type EngineStartOptions = StartOptions & { resumeSessionId?: string };

/** How a run ended: the promise every handle this engine returns carries. */
export function outcomeOf(handle: AgentHandle): Promise<RunOutcome> {
  const done = handle.done;
  if (!(done instanceof Promise)) throw new TypeError("not a handle from this engine");
  return done as Promise<RunOutcome>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The directory for one run's job files: exactly one plain segment under `jobsDir`. The id pattern already allows only
 * a uuid; this check is the second lock, on the joined path itself.
 */
export function jobDirFor(jobsDir: string, runId: string): string {
  try {
    return segmentUnder(jobsDir, runId);
  } catch (error) {
    if (error instanceof NotAPlainSegment) throw new EngineRefusal("bad_start_options", "run id is not a single path segment");
    throw error;
  }
}

/** The sandbox block must switch the sandbox on and leave no way out of it; anything else would start the agent with Bash and no OS sandbox. */
function sandboxIsOn(sandbox: Record<string, unknown>): boolean {
  try {
    assertEnabledSandbox(sandbox);
    return true;
  } catch {
    // fx-swallow-ok: the caller refuses the start with a closed reason
    return false;
  }
}

/**
 * The agent runtime for the user's installed CLI. Preflight, in order, and each refusal happens before the job's process exists:
 * the role must be known, the binary must pass the version and flag checks, and a login of the right kind must be present. Then the binary
 * is spawned (no shell, explicit argv, `cleanEnv` as its whole environment) with the prompt on standard input.
 */
export function createClaudeEngine(config: EngineConfig): AgentRuntime & { interrupt(handle: AgentHandle): void } {
  const spawnFn = config.spawn ?? spawn;
  const graceMs = config.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  async function run(opts: EngineStartOptions, resumeSessionId: string | undefined): Promise<{ handle: AgentHandle }> {
    let roleTools: readonly string[];
    try {
      roleTools = roleToolsFor(opts.role);
    } catch (error) {
      if (error instanceof UnknownRoleError) throw new EngineRefusal("unknown_role");
      throw error;
    }
    const workdir = opts.workdir;
    const idOk = RUN_ID.test(opts.runId) && CLI_MODEL.test(opts.model) && (resumeSessionId === undefined || (SESSION_ID_PATTERN.test(resumeSessionId) && !resumeSessionId.startsWith("-")));
    if (workdir === undefined || !path.isAbsolute(workdir) || !idOk) throw new EngineRefusal("bad_start_options");
    if (!sandboxIsOn(config.sandboxSettings)) throw new EngineRefusal("bad_start_options", "sandbox block is not enabled");
    const jobDir = jobDirFor(config.jobsDir, opts.runId);

    const env = cleanEnv(config.credentials, config.envOptions);
    const binary = await config.binary(env);
    // The minimum is enforced here too, so a BinarySource other than storedBinarySource cannot get a build below it past the engine.
    if (!versionSupported(binary.version)) throw new EngineRefusal("claude_version_unsupported", `version ${binary.version} is older than ${MIN_CLAUDE_VERSION}; upgrade Claude Code`);
    if (!(await authPresent(config.credentials.mode, { binaryPath: binary.path, env, spawn: spawnFn })).present) throw new EngineRefusal("auth_missing");

    const files = writeJobFiles(jobDir, workdir, opts.role, config.sandboxSettings, config.protectedPaths);
    const argv = claudeArgv({ cliModel: opts.model, roleTools, allowRules: confineFileTools(roleTools, path.resolve(workdir)), ...files, ...(resumeSessionId === undefined ? {} : { resumeSessionId }) });
    const secrets = [env.ANTHROPIC_API_KEY, env[SUBSCRIPTION_TOKEN_VAR]].filter((value): value is string => typeof value === "string");
    const log = createRunLog(config.logDir, opts.runId, secrets);

    const child = spawnFn(binary.path, argv, { cwd: workdir, env, shell: false, detached: OWN_PROCESS_GROUP, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin?.on("error", () => {
      // fx-swallow-ok: the agent exiting before it read its prompt is reported through its exit, not here
    });
    child.stdin?.end(opts.prompt);

    const handle: AgentHandle = { runId: opts.runId, child, options: opts };
    handle.done = new Promise<RunOutcome>((resolve) => {
      let seq = 0;
      let localSeq = 0;
      let sawInit = false;
      let mismatch = false;
      let noInit = false;
      let modeForced = false;
      let result: Record<string, unknown> | undefined;
      let sessionId: string | undefined;
      let agentOutput: Record<string, unknown> | undefined;
      const engineVersion = binary.version;
      log.write("meta", JSON.stringify({ engine_version: engineVersion }));
      // The version goes out first, so a breaking release shows up across runs.
      let chain: Promise<void> = Promise.resolve(config.onLocalEvent?.({ seq: localSeq++, ts: new Date().toISOString(), type: "engine_version", engine_version: engineVersion }));
      let stderrTail = "";
      const lineBuffer = new LineBuffer();

      const handleLine = async (line: string): Promise<void> => {
        log.write("stdout", line);
        if (mismatch || noInit || modeForced || line.trim() === "") return;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          // fx-swallow-ok: a line that is not JSON carries no event; it is already in the raw log
          return;
        }
        if (!isRecord(message)) return;
        // The first line must be the init line, and its credential source must be the one this mode allows. Nothing
        // else is processed (or uploaded) before that holds.
        if (!sawInit) {
          if (!isInitLine(message)) {
            // Not a credential problem: the stream did not open the way this engine requires (an early error result, a build that changed its output).
            noInit = true;
            void terminateGroup(child, graceMs);
            return;
          }
          if (!initCredentialMatches(config.credentials.mode, message)) {
            mismatch = true;
            void terminateGroup(child, graceMs);
            await config.onLocalEvent?.({ seq: localSeq++, ts: new Date().toISOString(), type: "credential_mismatch" });
            return;
          }
          sawInit = true;
        }
        const event = normalizeMessage({ runId: opts.runId, role: opts.role }, message, seq++, workdir);
        if (event.sessionId !== undefined && SESSION_ID_PATTERN.test(event.sessionId)) sessionId = event.sessionId;
        if (message.type === "result") {
          result = message;
          agentOutput = event.agentOutput;
        }
        await opts.onEvent(event);
        for (const local of projectLocalOnly(message, event, () => localSeq++, workdir)) await config.onLocalEvent?.(local);
      };
      const enqueue = (line: string): void => {
        chain = chain.then(() => handleLine(line)).catch(() => {
          // fx-swallow-ok: one failing consumer must not stop the run's remaining lines from reaching the log
        });
      };

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => lineBuffer.push(chunk).forEach(enqueue));
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        log.write("stderr", chunk);
        if (stderrTail.length < 4096) stderrTail += chunk;
        // The warning can arrive split across chunks, so the accumulated tail is searched as well as the chunk.
        if (!modeForced && (PERMISSION_MODE_FORCED.test(chunk) || PERMISSION_MODE_FORCED.test(stderrTail))) {
          modeForced = true;
          void terminateGroup(child, graceMs);
        }
      });
      child.on("error", () => resolve({ status: "failed", failureReason: "agent_exit", engineVersion }));
      child.on("close", (code) => {
        lineBuffer.end().forEach(enqueue);
        void chain.then(async () => {
          if (sessionId !== undefined && !mismatch && !noInit && !modeForced) {
            try {
              await recordSession(config.sessionsFile, sessionId, workdir);
            } catch {
              // fx-swallow-ok: a session that could not be indexed is only not resumable later; the outcome is unchanged
            }
          }
          const base = { engineVersion, ...(sessionId === undefined ? {} : { sessionId }), ...(agentOutput === undefined ? {} : { agentOutput }) };
          if (modeForced) resolve({ status: "failed", failureReason: "permission_mode_forced", engineVersion });
          else if (mismatch) resolve({ status: "failed", failureReason: "credential_mismatch", engineVersion });
          else if (noInit) resolve({ status: "failed", failureReason: "no_init_line", engineVersion });
          // Backstop for a build that dropped a flag after the --help check: an unknown-option exit before any init line.
          else if (!sawInit && code !== 0 && /unknown (option|argument)|unrecognized (option|argument)|invalid option/i.test(stderrTail)) resolve({ status: "failed", failureReason: "claude_flags_unsupported", engineVersion });
          else if (result === undefined) resolve({ status: "failed", failureReason: "agent_exit", ...base });
          else if (result.is_error === true) resolve({ status: "failed", failureReason: "agent_error", ...base });
          else resolve({ status: "ok", ...base });
        });
      });
    });
    return { handle };
  }

  return {
    start: (opts: StartOptions) => run(opts, (opts as EngineStartOptions).resumeSessionId),
    interrupt(handle) {
      // SIGINT to the agent process itself: it ends its turn cleanly (SIGTERM would leave it unfinished). The group is stopped later, with the sandbox.
      (handle.child as ChildProcess | undefined)?.kill("SIGINT");
    },
    async stop(handle) {
      const child = handle.child as ChildProcess | undefined;
      // The whole process group, not the pid alone: a tool call's background process must not outlive the job.
      await Promise.all([child === undefined ? Promise.resolve() : terminateGroup(child, graceMs), outcomeOf(handle)]);
    },
    resume(handle, sessionId, prompt) {
      const previous = handle.options as EngineStartOptions | undefined;
      if (previous === undefined) throw new EngineRefusal("bad_start_options", "handle has no start options");
      return run({ ...previous, prompt }, sessionId);
    },
  };
}
