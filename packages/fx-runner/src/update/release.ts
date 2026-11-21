/**
 * Which release is the newest one that can be served (D#845 ON-4a). Pure and dependency-free: the updater and the cloud's install route
 * both read the verified target list through this one rule, so they cannot disagree about what "newest" means.
 */

const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const TARGET = /^v([^/]+)\/fx-runner-([a-z0-9-]+)$/;

/** `x.y.z` only: a build tag, a pre-release or anything else is not a version this updater will install or compare. */
export function isVersion(text: unknown): text is string {
  return typeof text === "string" && SEMVER.test(text);
}

/** Negative when `a` is older than `b`, zero when equal, positive when newer. Both must pass `isVersion`. */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return 0;
}

/**
 * The newest `x.y.z` for which every one of `platforms` has a `v<x.y.z>/fx-runner-<platform>` target in `paths`. A version that lacks any
 * of them is not a candidate. The updater asks for its own platform only; the install route asks for all four. No platforms, no answer.
 */
export function newestRelease(paths: Iterable<string>, platforms: readonly string[]): string | undefined {
  if (platforms.length === 0) return undefined;
  const found = new Map<string, Set<string>>();
  for (const target of paths) {
    const match = target.match(TARGET);
    if (match === null || !isVersion(match[1])) continue;
    const have = found.get(match[1]) ?? new Set<string>();
    have.add(match[2] as string);
    found.set(match[1], have);
  }
  let best: string | undefined;
  for (const [version, have] of found) {
    if (!platforms.every((platform) => have.has(platform))) continue;
    if (best === undefined || compareVersions(version, best) > 0) best = version;
  }
  return best;
}
