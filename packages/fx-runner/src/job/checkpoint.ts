/**
 * The checkpoint turn of a run that is being moved to the other side: the one prompt the runner resumes the agent's session with, and the handoff
 * note it reads back.
 *
 * The prompt is a constant compiled into this package. It holds no job text, no branch, no path and no earlier model output, so what the agent is told
 * in this turn cannot be steered by the repository or the job (a test pins its hash; the cloud's own checkpoint turn pins the same one). The note
 * is the agent's answer to it: `{ done, next, paths }`, kept on this machine. Nothing here sends it anywhere; whether any of it may leave the machine
 * is decided elsewhere, with the person's consent.
 */

/** The longest `done` or `next`, in UTF-8 bytes (1 KiB each). */
export const CHECKPOINT_TEXT_MAX_BYTES = 1024;
/** The most paths a note keeps. */
export const CHECKPOINT_PATHS_MAX = 50;
/** The longest single path a note keeps, in characters. */
export const CHECKPOINT_PATH_MAX_CHARS = 512;
/** The cap `sanitizeCheckpointSummary` applies when none is given: the cloud's own limit for an agent's checkpoint summary (4 KiB). */
export const MAX_CHECKPOINT_SUMMARY_BYTES = 4096;

/**
 * The agent's second turn. It commits and describes; it does not push (the runner pushes, outside the sandbox, with credentials the agent never
 * holds). Changing one character changes the pinned hash on purpose: the cloud's turn must say exactly the same.
 */
export const CHECKPOINT_PROMPT = [
  "This run is being moved to another machine, so stop what you are doing and finish up. Do exactly two things, in this order.",
  "",
  "1. Commit every change you have made in this repository, on the branch you are on, in one or more commits. Leave nothing uncommitted. Do not push; the runner pushes for you. Do not start any new work.",
  "",
  "2. End your reply with a handoff note for whoever continues this work, as one JSON object in exactly this form:",
  "",
  "<!-- AGENT_OUTPUT -->",
  "```json",
  '{"done": "what is finished, in plain words", "next": "what is left to do, in plain words", "paths": ["repo/relative/file", "another/file"]}',
  "```",
  "<!-- /AGENT_OUTPUT -->",
  "",
  "`done` and `next` are each at most 1000 characters. `paths` lists at most 50 files you changed, each relative to the repository root (no leading slash, no `..`). The note holds no commands, no credentials and no copied file content.",
].join("\n");

export interface CheckpointNote {
  done: string;
  next: string;
  paths: string[];
}

/**
 * Strips control and format characters (bidi, zero-width), then caps at `maxBytes` UTF-8 bytes on a character boundary. Never parsed for anything.
 * The same rule as the cloud's `sanitizeCheckpointSummary` (runStatusWriter.ts), which this public package may not import; a test holds the two
 * to the same answers.
 */
export function sanitizeCheckpointSummary(summary: string, maxBytes: number = MAX_CHECKPOINT_SUMMARY_BYTES): string {
  const bytes = Buffer.from(summary.replace(/[\p{Cc}\p{Cf}]/gu, ""), "utf8");
  if (bytes.length <= maxBytes) return bytes.toString("utf8");
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/** True for a path that names a file inside the repository: relative, no `.` or `..` segment, no empty segment, no backslash, no drive letter, no control character. */
export function isRepoRelativePath(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > CHECKPOINT_PATH_MAX_CHARS) return false;
  if (/[\p{Cc}\p{Cf}\\]/u.test(candidate) || candidate.startsWith("/") || /^[A-Za-z]:/.test(candidate) || candidate.startsWith("~")) return false;
  return candidate.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * The note from the agent's envelope, or undefined when it holds none. Anything else in the envelope is ignored. `done` and `next` pass through
 * `sanitizeCheckpointSummary` at 1 KiB; a path that is not repo-relative is dropped (not repaired), repeats are dropped, and only the first 50 stay.
 */
export function noteFromEnvelope(envelope: Record<string, unknown> | undefined): CheckpointNote | undefined {
  if (envelope === undefined) return undefined;
  const text = (value: unknown): string => (typeof value === "string" ? sanitizeCheckpointSummary(value, CHECKPOINT_TEXT_MAX_BYTES) : "");
  const paths: string[] = [];
  if (Array.isArray(envelope.paths)) {
    for (const entry of envelope.paths) {
      if (typeof entry === "string" && isRepoRelativePath(entry) && !paths.includes(entry)) paths.push(entry);
      if (paths.length === CHECKPOINT_PATHS_MAX) break;
    }
  }
  const note = { done: text(envelope.done), next: text(envelope.next), paths };
  return note.done === "" && note.next === "" && paths.length === 0 ? undefined : note;
}
