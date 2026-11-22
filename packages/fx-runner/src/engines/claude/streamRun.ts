import { ContextLedgerCapture, createUsageMeter, SESSION_ID_PATTERN, disabledToolsFor, normalizeMessage, type LocalOnlyEvent } from "@fulcrumaxe/runner-protocol";
import type { CredentialMode } from "../../job/cleanEnv.js";
import { initCredentialMatches, isInitLine } from "./credentialCheck.js";
import { verifyServerUp } from "./settingsFile.js";
import { LineBuffer, nearLimitOf, projectLocalOnly, type StageMarks } from "./stream.js";
import type { EngineStartOptions, RunOutcome } from "./engine.js";
import { RAW_TAIL_CHARS, earlyExit } from "../../sandbox/startFailure.js";

/**
 * What the CLI writes to stderr when it overrides the permission mode a caller asked for (it does that whenever
 * `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is set and a non-default mode was passed). This engine passes none, so seeing it
 * means a build or an argument list changed under it: the run is stopped and fails closed instead of carrying on with
 * a mode nobody chose.
 */
export const PERMISSION_MODE_FORCED = /permission mode forced to default/i;

/**
 * How the agent's process ended, as the caller knows it. `code` and `signal` are what a child process reports on close.
 * `lost` is set when the source of the lines vanished without saying how the command ended (a guest that went away,
 * a stream that closed with no exit frame): there is then no code, and the run never reports `ok`.
 */
export interface AgentStreamEnd {
  code: number | null;
  signal: string | number | null;
  lost?: true;
}

/** The end of a stream that was lost: no code, no signal, never read as a clean end. */
export const LOST_STREAM: AgentStreamEnd = { code: null, signal: null, lost: true };

/**
 * The guest agent's `exit` frame, as the guest path receives it. Mapping to the engine's code: `124` when the command
 * timed out (the guest kills it on the deadline, so its signal is set too; the timeout is the reason), the exit
 * code when there is one, `128 + signal` when a signal ended it. A frame with none of the three is a lost command.
 */
export interface GuestExitFrame {
  exit: number | null;
  signal: number | null;
  timedOut: boolean;
}

export function endOfGuestExit(frame: GuestExitFrame): AgentStreamEnd {
  if (frame.timedOut) return { code: 124, signal: frame.signal };
  if (frame.exit !== null) return { code: frame.exit, signal: null };
  if (frame.signal !== null) return { code: 128 + frame.signal, signal: frame.signal };
  return LOST_STREAM;
}

/**
 * Turns the byte chunks of one stream into text chunks without splitting a multi-byte character. A guest path whose
 * source carries Buffers passes them through this; a host child that already has an encoding set needs nothing.
 */
export async function* textChunks(source: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8");
  for await (const chunk of source) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    if (text !== "") yield text;
  }
  const rest = decoder.decode();
  if (rest !== "") yield rest;
}

/**
 * The hostile-line ceilings of the usage meter: the most input-side tokens and output tokens one line may claim, and the most
 * distinct message ids the meter keeps. Output that is not the person's own CLI is untrusted, and with unbounded values the
 * per-id map and the transcript grow without limit, so a caller that reads guest output MUST pass bounded values.
 */
export interface UsageLimits {
  maxLineInputSideTokens: number;
  maxLineOutputTokens: number;
  maxIds: number;
}

/** What the host engine passes: the agent is the person's own CLI on their own machine, so the ceilings are lifted. */
export const HOST_USAGE_LIMITS: UsageLimits = { maxLineInputSideTokens: Number.MAX_SAFE_INTEGER, maxLineOutputTokens: Number.MAX_SAFE_INTEGER, maxIds: Number.MAX_SAFE_INTEGER };

/**
 * Everything the stream handling needs from whoever started the agent. The host engine fills it from a child process; the guest
 * path fills it from the guest agent's frames (stdout and stderr data frames through `textChunks`, the `exit` frame through
 * `endOfGuestExit`, a lost stream as `LOST_STREAM`). Nothing here reads a process, a path or the environment.
 */
export interface AgentStreamInput {
  options: EngineStartOptions;
  /** The run's working directory: absolute, and already checked by the caller. */
  workdir: string;
  credentials: CredentialMode;
  /** The agent build the run used; reported in every outcome. */
  engineVersion: string;
  /** Text chunks of the agent's standard output and standard error. Both are read to their end before the outcome is decided. */
  stdout: AsyncIterable<string>;
  stderr: AsyncIterable<string>;
  /** How the process ended. Awaited together with the two streams. */
  ended: Promise<AgentStreamEnd>;
  /** Stops the agent (and what it started) when the stream shows the run must not go on. Not awaited. */
  terminate: () => void | Promise<void>;
  /** The usage meter's ceilings. Required so no caller gets unbounded ones by omission; the guest path must pass bounded values (see `UsageLimits`). */
  usageLimits: UsageLimits;
  /** The raw transcript sink (already redacting). */
  log: { write(kind: "stdout" | "stderr" | "meta", line: string): void };
  /** Strings that must never appear in a local event. */
  secrets?: readonly string[];
  /** The user's home directory, blanked in a start failure's stderr tail (any `/home/<name>` is blanked too). */
  home?: string;
  onLocalEvent?: (event: LocalOnlyEvent) => void | Promise<void>;
  onNearLimit?: (info: { resetsAtMs?: number }) => void;
  /** Asked after a non-clean end that no other rung explains: did the kernel enforce the memory budget? An error counts as no. Absent: never `resource_limit`. */
  resourceLimitExceeded?: () => Promise<boolean>;
  /** The playwright job's `fxverify` check applies when this is true. */
  checkVerifyServer?: boolean;
  /** Called when a session id was seen and the run was not stopped by a rung above, with the run's last context size in tokens. A failure is ignored. */
  onSession?: (sessionId: string, lastContextTokens: number) => Promise<void>;
}

/** Reads a stream, handing each chunk over; a source that breaks counts as ended (the outcome decides what that means). */
async function pump(source: AsyncIterable<string>, onChunk: (chunk: string) => void): Promise<void> {
  try {
    for await (const chunk of source) onChunk(chunk);
  } catch {
    // fx-swallow-ok: a source that failed mid-read ends the same way a closed one does; the caller's `ended` says how the process ended
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The agent's output turned into events and a closed outcome: the line buffer, the init-line check, the credential match,
 * the fxverify check, the context ledger, normalisation, the usage meter, the near-limit and local-only projections,
 * the stderr permission-mode scan, and the outcome ladder. One function for both transports, so a guest run is read exactly
 * as a host run is. Listeners attach before the first await.
 */
export function runAgentStream(input: AgentStreamInput): Promise<RunOutcome> {
  const { options: opts, credentials, engineVersion, log } = input;
  const secrets = input.secrets ?? [];
  const workdir = input.workdir;
  const excludes = opts.excludes;
  const verifyCheck = input.checkVerifyServer === true;
  let seq = 0;
  let localSeq = 0;
  const marks: StageMarks = { writingResult: false };
  let sawInit = false;
  let mismatch = false;
  let noInit = false;
  let modeForced = false;
  // D#749: a playwright job whose `fxverify` server is not up at the init line ends before its first turn, under its own closed code (never a tool-less answer).
  let browserDown = false;
  let result: Record<string, unknown> | undefined;
  let sessionId: string | undefined;
  let agentOutput: Record<string, unknown> | undefined;
  const ledger = new ContextLedgerCapture(disabledToolsFor(excludes));
  // The run total is metered from every assistant message and the result line's cumulative figures, with the same meter the sandbox path
  // uses: the result line's own `usage` alone can describe one turn. The ceilings come from the caller (the host lifts them, the guest bounds them).
  const meter = createUsageMeter({ ...input.usageLimits });
  log.write("meta", JSON.stringify({ engine_version: engineVersion }));
  // The version goes out first, so a breaking release shows up across runs.
  let chain: Promise<void> = Promise.resolve(input.onLocalEvent?.({ seq: localSeq++, ts: new Date().toISOString(), type: "engine_version", engine_version: engineVersion }));
  let stderrTail = "";
  // The last stretch of raw stderr and whether stdout said anything at all: what a start failure's diagnostic is made from.
  let stderrLast = "";
  let stderrCut = false;
  let sawOutput = false;
  const lineBuffer = new LineBuffer();

  const handleLine = async (line: string): Promise<void> => {
    log.write("stdout", line);
    if (mismatch || noInit || modeForced || browserDown || line.trim() === "") return;
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
        void input.terminate();
        return;
      }
      if (!initCredentialMatches(credentials.mode, message)) {
        mismatch = true;
        void input.terminate();
        await input.onLocalEvent?.({ seq: localSeq++, ts: new Date().toISOString(), type: "credential_mismatch" });
        return;
      }
      sawInit = true;
      if (verifyCheck && !verifyServerUp(message)) {
        browserDown = true;
        void input.terminate();
        return;
      }
    }
    // Integers only leave the capture (no text, no path); the result line comes last, so its snapshot covers the whole command.
    ledger.observe(message);
    const normalized = normalizeMessage({ runId: opts.runId, role: opts.role }, message, seq++, workdir);
    // D#600 CX-9b: beside the integers, the window the job named (when it did), so the cloud can say how full the context was.
    const windowNow = opts.contextWindowTokens;
    const event = message.type === "result" ? { ...normalized, contextLedger: { ...ledger.snapshot(), ...(windowNow === undefined ? {} : { window_tokens: windowNow }) } } : normalized;
    if (event.sessionId !== undefined && SESSION_ID_PATTERN.test(event.sessionId)) sessionId = event.sessionId;
    if (message.type === "result") {
      result = message;
      agentOutput = event.agentOutput;
    }
    await opts.onEvent(event);
    const near = nearLimitOf(message);
    if (near !== undefined) input.onNearLimit?.(near);
    meter.observe(event);
    for (const local of projectLocalOnly(message, event, () => localSeq++, workdir, secrets, marks, meter.total())) await input.onLocalEvent?.(local);
  };
  const enqueue = (line: string): void => {
    chain = chain.then(() => handleLine(line)).catch(() => {
      // fx-swallow-ok: one failing consumer must not stop the run's remaining lines from reaching the log
    });
  };

  const stdoutDone = pump(input.stdout, (chunk) => {
    if (chunk.length > 0) sawOutput = true;
    lineBuffer.push(chunk).forEach(enqueue);
  });
  const stderrDone = pump(input.stderr, (chunk) => {
    // The scan comes before any log write, so a sink that throws can never hide the warning (fail closed).
    if (stderrTail.length < 4096) stderrTail += chunk;
    if (stderrLast.length + chunk.length > RAW_TAIL_CHARS) stderrCut = true;
    stderrLast = (stderrLast + chunk).slice(-RAW_TAIL_CHARS);
    // The warning can arrive split across chunks, so the accumulated tail is searched as well as the chunk.
    if (!modeForced && (PERMISSION_MODE_FORCED.test(chunk) || PERMISSION_MODE_FORCED.test(stderrTail))) {
      modeForced = true;
      void input.terminate();
    }
    try {
      log.write("stderr", chunk);
    } catch {
      // fx-swallow-ok: a transcript that cannot be written must not stop stderr from being read and scanned; the outcome does not depend on the log
    }
  });

  return (async (): Promise<RunOutcome> => {
    const [end] = await Promise.all([input.ended, stdoutDone, stderrDone]);
    lineBuffer.end().forEach(enqueue);
    await chain;
    // A clean end needs no question; any other end may be the kernel enforcing the memory budget, which only the scope can say.
    // A lost stream is decided first (and never asks the memory question): the other signals may be incomplete, so none of their verdicts can be trusted.
    const lost = end.lost === true;
    const limited = !lost && input.resourceLimitExceeded !== undefined && end.code !== 0 && !mismatch && !noInit && !modeForced && !browserDown ? await input.resourceLimitExceeded().catch(() => false) : false;
    if (sessionId !== undefined && !mismatch && !noInit && !modeForced && !browserDown) {
      try {
        await input.onSession?.(sessionId, ledger.lastContextTokens());
      } catch {
        // fx-swallow-ok: a session that could not be indexed is only not resumable later; the outcome is unchanged
      }
    }
    const denied = ledger.deniedToolCalls();
    const base = { engineVersion, ...(denied > 0 ? { deniedToolCalls: denied } : {}), ...(sessionId === undefined ? {} : { sessionId }), ...(agentOutput === undefined ? {} : { agentOutput }) };
    if (lost) return { status: "failed", failureReason: "agent_exit", ...(mismatch || noInit || modeForced || browserDown ? { engineVersion } : base) };
    if (limited) return { status: "failed", failureReason: "resource_limit", ...base };
    if (modeForced) return { status: "failed", failureReason: "permission_mode_forced", engineVersion };
    if (mismatch) return { status: "failed", failureReason: "credential_mismatch", engineVersion };
    if (noInit) return { status: "failed", failureReason: "no_init_line", engineVersion };
    if (browserDown) return { status: "failed", failureReason: "verify_browser_unavailable", engineVersion };
    // Backstop for a build that dropped a flag after the --help check: an unknown-option exit before any init line.
    if (!sawInit && end.code !== 0 && /unknown (option|argument)|unrecognized (option|argument)|invalid option/i.test(stderrTail)) return { status: "failed", failureReason: "claude_flags_unsupported", engineVersion };
    // A lost command is reported as one: a result line that was seen stays in the outcome's fields, but only a clean end is `ok`.
    if (result === undefined) return { status: "failed", failureReason: "agent_exit", ...base, ...(sawOutput ? {} : { startFailure: earlyExit(end, stderrLast, secrets, input.home, stderrCut) }) };
    if (result.is_error === true) return { status: "failed", failureReason: "agent_error", ...base };
    return { status: "ok", ...base };
  })();
}
