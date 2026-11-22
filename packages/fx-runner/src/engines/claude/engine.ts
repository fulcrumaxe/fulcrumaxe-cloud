import { NotAPlainSegment, segmentUnder } from "../../job/plainSegment.js";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { CONTEXT_WARN_PCT, SESSION_ID_PATTERN, contextNoteLine, contextPct, type AgentHandle, type AgentRuntime, type BrowserMethod, type LocalOnlyEvent, structuredSchemaFor, type StartOptions } from "@fulcrumaxe/runner-protocol";
import { assertEnabledSandbox, type ProtectedPaths } from "../../sandbox/sandboxSettings.js";
import { SUBSCRIPTION_TOKEN_VAR, cleanEnv, type CleanEnvOptions, type CredentialMode } from "../../job/cleanEnv.js";
import { UnknownRoleError, roleToolsFor } from "../../job/roleTools.js";
import type { JobLimits } from "../../sandbox/jobLimits.js";
import { chromeFlagFor, claudeArgv } from "./argv.js";
import { confineFileTools, readRulesFor } from "./filePermissions.js";
import { authPresent } from "./authStatus.js";
import type { SpawnFn } from "./capture.js";
import type { LaunchPlace } from "../../launchDir.js";
import { MIN_CLAUDE_VERSION, versionSupported, type BinarySource } from "./pin.js";
import { EngineRefusal } from "./refusal.js";
import { DEFAULT_KILL_GRACE_MS, OWN_PROCESS_GROUP, terminateGroup } from "./processGroup.js";
import { readSessionIndex, recordSession } from "./session.js";
import { bashSandboxUnusableFor, type SettingsWithDeny } from "./bashSandboxProbe.js";
import { clearVerifyLeftovers, writeJobFiles, type VerifyServerSpec } from "./settingsFile.js";
import { createRunLog } from "./stream.js";
import { notStarted, type StartFailure } from "../../sandbox/startFailure.js";
import { HOST_USAGE_LIMITS, PERMISSION_MODE_FORCED, runAgentStream, type AgentStreamEnd } from "./streamRun.js";

/** The job schema types a run id as a uuid, so the engine accepts nothing looser: the id names a directory and a log file. */
export const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CLI_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
export { PERMISSION_MODE_FORCED };

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
  /** Where the job's `auth status` question starts (D#6 RUNNER-CWD-1): a fresh empty directory under the runner's launch root, never the daemon's own directory. */
  launch: LaunchPlace;
  /** How long a stopped agent gets to exit on SIGTERM before everything left in its process group is killed. Default 3000. */
  killGraceMs?: number;
  /** D#6 C43-5: the job's hard memory and task limits (a transient scope). Absent where none can be enforced. */
  limits?: JobLimits;
  /**
   * Test seam: the start-up question "can the shell sandbox start a Bash call under this job's rules?". Absent (every real run): `bashSandboxUnusableFor`, which runs the
   * machine's own bubblewrap. A test about engine behaviour on a host where bubblewrap cannot nest (inside the runner's own check sandbox) answers it itself; the refusal
   * code, and what the engine does with a true answer, are unchanged.
   */
  bashSandboxUnusable?: (settings: SettingsWithDeny, workspace: string, scratchParent: string, probe: { env: Record<string, string>; spawn: SpawnFn; launch: LaunchPlace }) => Promise<boolean>;
  /** Metadata-only events: the only run output meant for the cloud. */
  onLocalEvent?: (event: LocalOnlyEvent) => void | Promise<void>;
  /** The agent's near-limit warning (D#6 C43-6); `resetsAtMs` when it named a reset time. Nothing about it is uploaded. */
  onNearLimit?: (info: { resetsAtMs?: number }) => void;
  /**
   * D#749 V2c-2b: how the CLI starts the `fxverify` MCP server for a playwright job: this program's own command and the owner's three browser settings (read again at each start).
   * Absent, or undefined at a start: a playwright job is refused before anything is spawned.
   */
  verifyServer?: () => VerifyServerSpec | undefined;
}

/** How a run ended. `failureReason` is a closed code; no model text is ever in it. */
export interface RunOutcome {
  status: "ok" | "failed";
  failureReason?: "credential_mismatch" | "no_init_line" | "claude_flags_unsupported" | "permission_mode_forced" | "agent_error" | "agent_exit" | "resource_limit" | "verify_browser_unavailable";
  /** The agent build the run used. */
  engineVersion: string;
  sessionId?: string;
  agentOutput?: Record<string, unknown>;
  /** D#600 CX-5c: how many Read, Grep, Glob or LS calls the job's permission rules refused; present only when at least one was. An integer, counted the way the cloud's sandbox counts it. Kept on this machine: no field of the runner's wire carries it. */
  deniedToolCalls?: number;
  /** Why the agent never started or ended before its first output: closed cause, exit code or signal, errno, redacted stderr tail. Kept on this machine, for the runner's local log. */
  startFailure?: StartFailure;
}

/** The start options this engine reads. `resumeSessionId` is set by the session planner when a workspace and session are both still there. */
export type EngineStartOptions = StartOptions & { resumeSessionId?: string; /** D#600 CX-5c: paths and globs kept out of context; written as deny entries on every start and resume of the job. */ excludes?: readonly string[]; /** D#600 CX-4b: the run's spill directory; the file tools may read it. */ spillDir?: string; /** D#600 CX-6b: the model's context window in tokens, from the job. Absent: no context percentage is computed and no note is ever delivered. */ contextWindowTokens?: number; /** D#6 RUNNER-AGENT-NO-FULLCHECK: the job's approved check, denied to the agent's shell on every start and resume (the runner runs it itself). */ checkArgv?: readonly string[]; /** D#749 V2c-2b: the deploy verifier's signed browser method; it picks the tool list, the MCP file and the chrome flag. */ browserMethod?: BrowserMethod };

/** How a run ended: the promise every handle this engine returns carries. */
export function outcomeOf(handle: AgentHandle): Promise<RunOutcome> {
  const done = handle.done;
  if (!(done instanceof Promise)) throw new TypeError("not a handle from this engine");
  return done as Promise<RunOutcome>;
}

/** The source of a stream a child was started without (never the case for these stdio settings). */
const NO_OUTPUT: AsyncIterable<string> = (async function* () {})();

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
      roleTools = roleToolsFor(opts.role, (opts as EngineStartOptions).browserMethod);
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
    if (!(await authPresent(config.credentials.mode, { binaryPath: binary.path, env, spawn: spawnFn, launch: config.launch })).present) throw new EngineRefusal("auth_missing");

    const excludes = (opts as EngineStartOptions).excludes;
    const browserMethod = (opts as EngineStartOptions).browserMethod;
    // D#749 V2c-2b: a playwright job needs the fxverify server's settings from this machine. Without them the job is not started (the daemon's probe has refused it already; this is the second lock).
    const verifyServer = browserMethod === "playwright_runner" ? config.verifyServer?.() : undefined;
    if (browserMethod === "playwright_runner" && verifyServer === undefined) throw new EngineRefusal("bad_start_options", "the verify browser is not configured on this machine");
    const files = writeJobFiles(jobDir, workdir, opts.role, config.sandboxSettings, config.protectedPaths, excludes, (opts as EngineStartOptions).spillDir, (opts as EngineStartOptions).checkArgv, { browserMethod, verifyServer });
    // A run id that is started again (a re-claim after a crash) must not read the last attempt's answer or trip over its browser folders.
    if (browserMethod === "playwright_runner") clearVerifyLeftovers(jobDir);
    // The shell sandbox must be able to start a Bash call under this job's own rules. If bubblewrap refuses, every Bash call would fail and the agent would loop to "incomplete", so the run ends now.
    if (await (config.bashSandboxUnusable ?? bashSandboxUnusableFor)(files.settings, workdir, path.join(jobDir, "probe"), { env, spawn: spawnFn, launch: config.launch })) throw new EngineRefusal("sandbox_unusable");
    const argv = claudeArgv({ cliModel: opts.model, roleTools, allowRules: [...confineFileTools(roleTools, path.resolve(workdir)), ...((opts as EngineStartOptions).spillDir === undefined ? [] : readRulesFor((opts as EngineStartOptions).spillDir!))], ...files, chrome: chromeFlagFor(opts.role, (opts as EngineStartOptions).browserMethod), ...(structuredSchemaFor(opts.role) === undefined ? {} : { jsonSchema: structuredSchemaFor(opts.role)! }), ...(resumeSessionId === undefined ? {} : { resumeSessionId }) });
    const secrets = [env.ANTHROPIC_API_KEY, env[SUBSCRIPTION_TOKEN_VAR]].filter((value): value is string => typeof value === "string");
    const log = createRunLog(config.logDir, opts.runId, secrets);

    // Under a scope the agent is still this child's own program (systemd-run moves itself into the scope and then runs it), so the
    // group, the signals and the exit code are the agent's. The agent's environment is the one built above.
    const launch = config.limits?.wrap({ runId: opts.runId, role: opts.role }, binary.path, argv, env) ?? { command: binary.path, args: argv, env };
    const launchEnv = launch.env;
    const child = spawnFn(launch.command, launch.args, { cwd: workdir, env: launchEnv, shell: false, detached: OWN_PROCESS_GROUP, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin?.on("error", () => {
      // fx-swallow-ok: the agent exiting before it read its prompt is reported through its exit, not here
    });
    // D#600 CX-6b: a command that resumes a session starts with one line when that session's last command ended at or above CONTEXT_WARN_PCT of the window, once per value. The figure is the
    // runner's own (computed from the stream's usage, kept in the session index it already writes); no hook runs, and nothing is sent anywhere.
    const known = resumeSessionId === undefined ? undefined : readSessionIndex(config.sessionsFile)[resumeSessionId];
    const notePct = known?.contextPct !== undefined && known.contextPct >= CONTEXT_WARN_PCT && known.notedPct !== known.contextPct ? known.contextPct : undefined;
    child.stdin?.end(notePct === undefined ? opts.prompt : `${contextNoteLine(notePct)}\n\n${opts.prompt}`);

    const handle: AgentHandle = { runId: opts.runId, child, options: opts };
    const engineVersion = binary.version;
    const ended = new Promise<AgentStreamEnd>((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    handle.done = new Promise<RunOutcome>((resolve) => {
      child.on("error", (error) => resolve({ status: "failed", failureReason: "agent_exit", engineVersion, startFailure: notStarted(error, secrets, env.HOME) }));
      void runAgentStream({
        options: opts,
        workdir,
        credentials: config.credentials,
        engineVersion,
        stdout: child.stdout ?? NO_OUTPUT,
        stderr: child.stderr ?? NO_OUTPUT,
        ended,
        terminate: () => terminateGroup(child, graceMs),
        usageLimits: HOST_USAGE_LIMITS,
        log,
        secrets,
        home: env.HOME,
        ...(config.onLocalEvent === undefined ? {} : { onLocalEvent: config.onLocalEvent }),
        ...(config.onNearLimit === undefined ? {} : { onNearLimit: config.onNearLimit }),
        ...(config.limits === undefined ? {} : { resourceLimitExceeded: () => config.limits!.exceeded(opts.runId) }),
        checkVerifyServer: browserMethod === "playwright_runner",
        onSession: async (sessionId, lastContextTokens) => {
          const windowTokens = (opts as EngineStartOptions).contextWindowTokens;
          const pctNow = windowTokens === undefined ? undefined : contextPct(lastContextTokens, windowTokens);
          await recordSession(config.sessionsFile, sessionId, workdir, { contextPct: pctNow, notedPct: pctNow !== undefined && pctNow < CONTEXT_WARN_PCT ? undefined : notePct ?? known?.notedPct });
        },
      }).then(resolve);
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
