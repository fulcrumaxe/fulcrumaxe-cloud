/**
 * D#6 M1G-a: the operator's human-merge-only lock.
 *
 * `FX_HUMAN_MERGE_ONLY_REPO_IDS` is a comma-separated list of numeric GitHub repository ids (ids, not names, so a rename
 * does not lift the lock). For a listed repository a person merges every pull request: the merge gate never calls merge,
 * and turning on auto-merge or the local-review opt-in is refused.
 *
 * One function answers the question, `humanMergeOnly(repoGhId)`. It reads the environment on every call (no cache, so a
 * redeploy with a new value takes effect at once) and fails closed:
 *  - unset or empty: nothing is locked (today's behaviour);
 *  - malformed (anything but digits separated by single commas: no spaces, no sign, no leading zero): EVERY repository is
 *    locked until the value is fixed, and /api/health reports `human_merge_only_config_invalid`;
 *  - a repository whose id is unknown while the list is non-empty counts as locked (it cannot be shown to be unlisted).
 *
 * Nothing is stored, so removing an id and redeploying lifts the lock.
 */

export const HUMAN_MERGE_ONLY_ENV = "FX_HUMAN_MERGE_ONLY_REPO_IDS";
/** The fixed code health reports for a malformed value. Never the value itself. */
export const HUMAN_MERGE_ONLY_INVALID_CODE = "human_merge_only_config_invalid";

/** One id: a positive integer without a leading zero, at most 15 digits, so always a safe integer. */
const ID_RE = /^[1-9][0-9]{0,14}$/;

export type HumanMergeOnlyConfig = { kind: "ok"; ids: ReadonlySet<number> } | { kind: "invalid" };

/** Parses the setting. `undefined` and `""` are an empty list; everything else must be exact (no spaces, no empty entries). */
export function parseHumanMergeOnlyIds(raw: string | undefined): HumanMergeOnlyConfig {
  if (raw === undefined || raw === "") return { kind: "ok", ids: new Set() };
  const ids = new Set<number>();
  for (const part of raw.split(",")) {
    if (!ID_RE.test(part)) return { kind: "invalid" };
    const n = Number(part);
    if (!Number.isSafeInteger(n)) return { kind: "invalid" };
    ids.add(n);
  }
  return { kind: "ok", ids };
}

export type RepoGhId = number | string | bigint | null | undefined;

function asId(value: RepoGhId): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value === "bigint") return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  if (typeof value === "string" && ID_RE.test(value)) return Number(value);
  return null;
}

type EnvLike = Readonly<Record<string, string | undefined>>;

/** True when a person must merge this repository's pull requests. Read from the environment now, on every call. */
export function humanMergeOnly(repoGhId: RepoGhId, env: EnvLike = process.env): boolean {
  const config = parseHumanMergeOnlyIds(env[HUMAN_MERGE_ONLY_ENV]);
  if (config.kind === "invalid") return true;
  if (config.ids.size === 0) return false;
  const id = asId(repoGhId);
  return id === null ? true : config.ids.has(id);
}

/** True when the setting is set to something that does not parse (every repository is then locked). */
export function humanMergeOnlyConfigInvalid(env: EnvLike = process.env): boolean {
  return parseHumanMergeOnlyIds(env[HUMAN_MERGE_ONLY_ENV]).kind === "invalid";
}
