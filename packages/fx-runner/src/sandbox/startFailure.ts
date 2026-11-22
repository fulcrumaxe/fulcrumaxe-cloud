import { redactText } from "@fulcrumaxe/runner-protocol";

/**
 * Why an agent process ended before it said anything, or never started: the closed `cause`, the exit code or signal, the spawn errno and the end of its
 * standard error, redacted. It stays on this machine (the runner's local log): the protocol's `run_ended` detail is a closed set of setup codes and has no place for it.
 */
export type StartFailureCause = "spawn_failed" | "exited_early" | "signal";

export interface StartFailure {
  cause: StartFailureCause;
  exitCode?: number;
  signal?: string;
  errno?: string;
  /** The last `TAIL_CHARS` of standard error after redaction (token shapes, known secrets, home paths). */
  tail: string;
}

/** What the log keeps of the agent's standard error. */
export const TAIL_CHARS = 2048;
/** How much raw standard error is held to take the tail from, so a token cut by the 2 KB edge is redacted whole before the cut. */
export const RAW_TAIL_CHARS = 8192;

const HOME_PATH = /(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)[^\s/\\"'`:]+/gi;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const ERRNO = /^E[A-Z0-9]{1,20}$/;
const SIGNAL = /^SIG[A-Z0-9]{1,12}$/;

/**
 * Redacts with the runner's own redactor first, then blanks paths under any user's home, control and direction characters, and keeps the last `TAIL_CHARS`.
 * `cut` says the caller's rolling window already lost its start. When the window was cut (here or by the caller) the text up to the first whitespace is dropped
 * BEFORE redaction, so a token whose start was cut off cannot leave a fragment the shape patterns no longer match.
 */
export function redactedTail(raw: string, secrets: readonly string[], home?: string, cut = false): string {
  let text = raw.slice(-RAW_TAIL_CHARS);
  if (cut || raw.length > RAW_TAIL_CHARS) text = text.replace(/^\S*/, "");
  text = redactText(text, secrets);
  if (home !== undefined && home.length > 1) text = text.split(home).join("~");
  text = text.replace(HOME_PATH, "~").replace(CONTROL, " ");
  return text.slice(-TAIL_CHARS);
}

/** An agent that ended (code or signal) before its first output line. */
export function earlyExit(end: { code: number | null; signal: string | number | null }, rawStderr: string, secrets: readonly string[], home?: string, cut = false): StartFailure {
  const signal = typeof end.signal === "string" && SIGNAL.test(end.signal) ? end.signal : undefined;
  const tail = redactedTail(rawStderr, secrets, home, cut);
  const code = end.code === null ? {} : { exitCode: end.code };
  if (end.signal !== null && end.signal !== undefined) return { cause: "signal", ...(signal === undefined ? {} : { signal }), ...code, tail };
  return { cause: "exited_early", ...code, tail };
}

/** A process that could not be started. The errno is kept only when it is a plain `ENOENT`-style word; the message (it names the binary path) goes through the same redaction. */
export function notStarted(error: unknown, secrets: readonly string[], home?: string): StartFailure {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : "";
  return { cause: "spawn_failed", ...(typeof code === "string" && ERRNO.test(code) ? { errno: code } : {}), tail: redactedTail(message, secrets, home) };
}

/** What the local log keeps of an uncoded error. */
export const THROWN_CHARS = 300;

/**
 * One log line's worth about an error that has no closed `code`: its `name` and the first line of its message (or `String(value)` for a rejection that is not an Error),
 * through the same redaction as the stderr tail (secrets, then home paths, then control and direction characters), capped at `THROWN_CHARS`.
 * It stays on this machine's log; nothing here reaches the protocol.
 */
export function describeThrown(error: unknown, secrets: readonly string[] = [], home?: string): string {
  let raw: string;
  try {
    const firstLine = (text: string): string => text.split(/\r\n|\r|\n/, 1)[0] ?? "";
    raw = error instanceof Error ? `${String(error.name)}: ${firstLine(String(error.message))}` : firstLine(String(error));
  } catch {
    // fx-swallow-ok: a value that cannot be printed (a throwing getter or toString) is logged as "unprintable"; the log line must never throw
    raw = "unprintable";
  }
  let text = redactText(raw, secrets);
  if (home !== undefined && home.length > 1) text = text.split(home).join("~");
  return text.replace(HOME_PATH, "~").replace(CONTROL, " ").slice(0, THROWN_CHARS);
}

/** One log line's worth: closed words and numbers, then the tail as a JSON string (so it stays one line). */
export function describeStartFailure(failure: StartFailure): string {
  const parts = [`cause=${failure.cause}`];
  if (failure.exitCode !== undefined) parts.push(`exit=${String(failure.exitCode)}`);
  if (failure.signal !== undefined) parts.push(`signal=${failure.signal}`);
  if (failure.errno !== undefined) parts.push(`errno=${failure.errno}`);
  parts.push(`stderr_tail=${JSON.stringify(failure.tail)}`);
  return parts.join(" ");
}
