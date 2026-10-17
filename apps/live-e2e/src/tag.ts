/**
 * The run-id tag (4c): everything a live test creates carries the run's id, and a test asserts only on objects that
 * carry its own. Pure; the id is made from a clock reading and random bytes handed in by the caller.
 *
 *   run id   20261016t184837z-a1b2c3          (UTC time, then six hex digits)
 *   tag      e2e-20261016t184837z-a1b2c3-<label>
 *   repo     e2e-tmp-20261016t184837z-a1b2c3  (the repo janitor, T6b, deletes only these, older than a day, in the test org)
 *
 * A name is "owned" by a run only when it parses to exactly that run id: a prefix test would also match a longer id.
 */
export const RUN_ID_PATTERN = /^[0-9]{8}t[0-9]{6}z-[0-9a-f]{6}$/;
export const TAG_PREFIX = "e2e-";
export const TMP_REPO_PREFIX = "e2e-tmp-";
const LABEL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_LABEL = 40;
const TAG_PATTERN = /^e2e-([0-9]{8}t[0-9]{6}z-[0-9a-f]{6})-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const TMP_REPO_PATTERN = /^e2e-tmp-([0-9]{8}t[0-9]{6}z-[0-9a-f]{6})$/;

export class TagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TagError";
  }
}

/** A fresh run id from the clock (ms since epoch) and at least three random bytes. */
export function newRunId(nowMs: number, random: Uint8Array): string {
  if (random.length < 3) throw new TagError("a run id needs at least 3 random bytes");
  const iso = new Date(nowMs).toISOString(); // 2026-10-16T18:48:37.123Z
  const stamp = `${iso.slice(0, 10).replaceAll("-", "")}t${iso.slice(11, 19).replaceAll(":", "")}z`;
  const hex = Array.from(random.slice(0, 3), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${stamp}-${hex}`;
}

export function isRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value);
}

/** `e2e-<run id>-<label>`; the label is lower-case words joined by dashes, at most 40 characters. */
export function tagFor(runId: string, label: string): string {
  if (!isRunId(runId)) throw new TagError("not a run id");
  if (label.length > MAX_LABEL || !LABEL_PATTERN.test(label)) throw new TagError("a tag label is lower-case words joined by dashes, at most 40 characters");
  return `${TAG_PREFIX}${runId}-${label}`;
}

/** The run id and label a tag carries, or null when the name is not a tag. */
export function parseTag(name: string): { runId: string; label: string } | null {
  const m = TAG_PATTERN.exec(name);
  return m === null ? null : { runId: m[1] as string, label: m[2] as string };
}

/** True only for a tag that carries exactly `runId`. */
export function ownedBy(name: string, runId: string): boolean {
  return isRunId(runId) && parseTag(name)?.runId === runId;
}

/** The name of the repo a `repo-create` test makes for this run. */
export function tmpRepoName(runId: string): string {
  if (!isRunId(runId)) throw new TagError("not a run id");
  return `${TMP_REPO_PREFIX}${runId}`;
}

/** The run id of a temporary repo name, or null. The repo janitor uses this and the owner check together. */
export function parseTmpRepo(name: string): string | null {
  return TMP_REPO_PATTERN.exec(name)?.[1] ?? null;
}
