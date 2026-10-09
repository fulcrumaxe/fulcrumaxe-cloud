/**
 * The last-tested store (T2b): per target, the last commit tested, the tier, the outcome and the time, in
 * `$HOME/.local/state/live-e2e/last-tested.json`. It lives in the live-run user's home, outside the wiped work
 * folder, so the next job (the fallback poller, the nightly skip rule, `--changed-from`) can read it.
 *
 * Written by atomic rename (a temp file in the same folder, mode 0600, then `rename`), so a reader never sees
 * half a file. A corrupt or unreadable file reads as empty with a warning: the store is a hint, never a reason
 * for a run to crash. The file is plain JSON (`jq` reads it in the poller, which has no Node).
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { TIERS, type Tier } from "./manifest.js";

export const LAST_TESTED_RELATIVE = join(".local", "state", "live-e2e", "last-tested.json");
const TARGET_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;
export const LAST_TESTED_OUTCOMES = ["pass", "fail"] as const;
export type LastTestedOutcome = (typeof LAST_TESTED_OUTCOMES)[number];

export interface LastTestedEntry {
  commit: string;
  tier: Tier;
  outcome: LastTestedOutcome;
  /** ISO time of the run. */
  at: string;
}

export interface LastTestedStore {
  version: 1;
  targets: Record<string, LastTestedEntry>;
}

export class LastTestedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LastTestedError";
  }
}

export function lastTestedPath(home: string): string {
  if (!isAbsolute(home)) throw new LastTestedError("HOME must be an absolute path");
  return join(home, LAST_TESTED_RELATIVE);
}

function validEntry(v: unknown): v is LastTestedEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.commit === "string" &&
    COMMIT_PATTERN.test(e.commit) &&
    typeof e.tier === "string" &&
    (TIERS as readonly string[]).includes(e.tier) &&
    typeof e.outcome === "string" &&
    (LAST_TESTED_OUTCOMES as readonly string[]).includes(e.outcome) &&
    typeof e.at === "string" &&
    !Number.isNaN(Date.parse(e.at))
  );
}

/** A missing file is an empty store without a warning; a corrupt one is empty with one. Entries that fail validation are dropped. */
export function readLastTested(home: string, warn: (line: string) => void = () => undefined): LastTestedStore {
  const empty: LastTestedStore = { version: 1, targets: {} };
  const file = lastTestedPath(home);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") warn(`last-tested: cannot read ${file}; treating it as empty`);
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    warn(`last-tested: ${file} is not valid JSON; treating it as empty`);
    return empty;
  }
  const targets = (parsed as { version?: unknown; targets?: unknown } | null)?.targets;
  if ((parsed as { version?: unknown } | null)?.version !== 1 || typeof targets !== "object" || targets === null || Array.isArray(targets)) {
    warn(`last-tested: ${file} has an unknown shape; treating it as empty`);
    return empty;
  }
  for (const [name, entry] of Object.entries(targets)) {
    if (TARGET_PATTERN.test(name) && validEntry(entry)) empty.targets[name] = entry;
    else warn(`last-tested: dropped an invalid entry for "${name.slice(0, 64)}"`);
  }
  return empty;
}

export function recordLastTested(home: string, target: string, entry: LastTestedEntry, warn: (line: string) => void = () => undefined): LastTestedStore {
  if (!TARGET_PATTERN.test(target)) throw new LastTestedError("target is not a plain target name");
  if (!validEntry(entry)) throw new LastTestedError("entry needs a hex commit, a known tier, outcome pass|fail and an ISO time");
  const store = readLastTested(home, warn);
  store.targets[target] = entry;
  const file = lastTestedPath(home);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw err;
  }
  return store;
}
