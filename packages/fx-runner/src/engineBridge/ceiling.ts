/**
 * The dial ceiling file (EB-9b). The runner asks the cloud what the repo's decisions resolve to, turns the answer into one small file in the engine's state
 * directory, and the engine lowers any dial of those classes that stands above it (the engine reads it with its own strict loader: this file is written to
 * what that loader accepts and nothing looser).
 *
 *  - `ask` is ceiling 1, `announce` and `act` are 5. `engine_spawn` sets `agent.spawn`; `engine_merge` sets both merge classes. `engine_spec_ready` sets none.
 *  - The file lives 15 minutes (`expires_at - fetched_at` is exactly 900 s, the most the engine accepts) and is written again every 5 minutes and when
 *    the pull says the controls changed. A fetch that fails writes nothing: the old file stays, runs out, and the engine then reads ceiling 1 for all three
 *    classes. The runner never writes a looser file from a guess, a stale answer, an answer for another repo or an answer it cannot read.
 *  - A halted repo is written with every ceiling at 1.
 *  - The file is written to a fresh temp file (0600, never through a link), fsynced, then renamed over the name, so a reader sees the old file or the new one.
 *    The state directory must be a plain directory of this user's, closed to others; a link or foreign file at the name is refused.
 * Every log line is fixed text: nothing the cloud sent reaches one.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { EngineDialsReply, engineDialsTarget } from "@fulcrumaxe/runner-protocol";
import { signedGet } from "../cloud.js";
import type { RunnerKey } from "../keys.js";
import type { Clock } from "../daemon/lease.js";

export const CEILING_FILE = "cloud-dial-ceiling.json";
export const CEILING_CLASSES = ["agent.spawn", "merge.standard", "merge.fast-path"] as const;
export type CeilingClass = (typeof CEILING_CLASSES)[number];
/** The engine accepts a life of at most this long; the file is written with exactly this. */
export const CEILING_LIFE_S = 900;
export const REFRESH_MS = 5 * 60_000;
/** A reply whose own clock is further than this from the runner's is not believed (a cached or replayed answer must not buy a fresh life). */
export const REPLY_SKEW_S = 300;

export type Disposition = "act" | "announce" | "ask";
/** `ask` holds the dial at level 1; `announce` and `act` leave the engine's own range (up to 5) alone. */
export const ceilingOf = (disposition: Disposition): 1 | 5 => (disposition === "ask" ? 1 : 5);

export interface CeilingFile {
  v: 1;
  repo_gh_id: number;
  fetched_at: string;
  expires_at: string;
  catalogue_version: number;
  halt_epoch: number;
  halted: boolean;
  ceilings: Record<CeilingClass, 1 | 5>;
}

/** The file for a reply, made at `fetchedAt` (the runner's own clock). A halted repo gets every ceiling at 1. */
export function buildCeiling(reply: EngineDialsReply, fetchedAt: Date): CeilingFile {
  const agentCeiling = ceilingOf(reply.dispositions.engine_spawn);
  const merge = ceilingOf(reply.dispositions.engine_merge);
  const halted = reply.halted;
  return {
    v: 1,
    repo_gh_id: reply.repo_gh_id,
    fetched_at: fetchedAt.toISOString(),
    expires_at: new Date(fetchedAt.getTime() + CEILING_LIFE_S * 1000).toISOString(),
    catalogue_version: reply.catalogue_version,
    halt_epoch: reply.halt_epoch,
    halted,
    ceilings: { "agent.spawn": halted ? 1 : agentCeiling, "merge.standard": halted ? 1 : merge, "merge.fast-path": halted ? 1 : merge },
  };
}

export type CeilingRefusal = "relative_dir" | "dir_not_plain" | "dir_foreign" | "dir_open" | "name_not_plain";
export class CeilingWriteRefused extends Error {
  constructor(readonly reason: CeilingRefusal) {
    super(`engine-bridge: the ceiling file was not written (${reason})`);
    this.name = "CeilingWriteRefused";
  }
}

/** Writes `file` to `<dir>/cloud-dial-ceiling.json`: temp file (0600, O_EXCL, O_NOFOLLOW), fsync, rename. `uid` is the runner's user id; undefined where the platform has none. */
export function writeCeiling(dir: string, file: CeilingFile, uid: number | undefined): void {
  if (!path.isAbsolute(dir)) throw new CeilingWriteRefused("relative_dir");
  let dirStat = lstatSync(dir, { throwIfNoEntry: false });
  if (dirStat === undefined) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    dirStat = lstatSync(dir);
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new CeilingWriteRefused("dir_not_plain");
  if (uid !== undefined && dirStat.uid !== uid) throw new CeilingWriteRefused("dir_foreign");
  if ((dirStat.mode & 0o077) !== 0) throw new CeilingWriteRefused("dir_open");
  const target = path.join(dir, CEILING_FILE);
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || !existing.isFile()) throw new CeilingWriteRefused("name_not_plain");
  }
  const body = Buffer.from(`${JSON.stringify(file)}\n`);
  const tmp = path.join(dir, `${CEILING_FILE}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    // The mode is set on the handle, so no umask and no later chmod-by-path can leave it wider.
    fchmodSync(fd, 0o600);
    if (!fstatSync(fd).isFile()) throw new CeilingWriteRefused("name_not_plain");
    writeSync(fd, body);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(tmp);
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(tmp, target);
  } catch (error) {
    unlinkSync(tmp);
    throw error;
  }
}

export type DialsOutcome = { kind: "ok"; reply: EngineDialsReply } | { kind: "failed"; why: "network" | "status" | "unexpected" | "other_repo" | "stale" };

export interface DialsFetcherConfig {
  origin: string;
  key: RunnerKey;
  now: () => Date;
  fetchFn: typeof fetch;
  bypass?: string | undefined;
}

/** One signed GET. It never throws and carries nothing the cloud sent except a reply that passed the protocol's strict schema, is for the repo asked about and is fresh. */
export function createDialsFetcher(config: DialsFetcherConfig): (repoGhId: number) => Promise<DialsOutcome> {
  return async (repoGhId) => {
    let reply;
    try {
      reply = await signedGet({ origin: config.origin, path: engineDialsTarget(repoGhId), headers: { accept: "application/json" }, key: config.key, now: config.now(), fetchFn: config.fetchFn, bypass: config.bypass });
    } catch {
      // fx-swallow-ok: the error text could name an address; a failed request is only the closed word "network"
      return { kind: "failed", why: "network" };
    }
    if (reply.protectedDeployment || reply.status !== 200) return { kind: "failed", why: "status" };
    const parsed = EngineDialsReply.safeParse(reply.body);
    if (!parsed.success) return { kind: "failed", why: "unexpected" };
    if (parsed.data.repo_gh_id !== repoGhId) return { kind: "failed", why: "other_repo" };
    // Fails closed: a date that does not parse is NaN, and NaN is not within the limit (a plain `> limit` would let it through as fresh).
    if (!(Math.abs(Date.parse(parsed.data.fetched_at) - config.now().getTime()) <= REPLY_SKEW_S * 1000)) return { kind: "failed", why: "stale" };
    return { kind: "ok", reply: parsed.data };
  };
}

export type RefreshResult = "written" | "kept_old";

export interface CeilingKeeperDeps {
  fetchDials: (repoGhId: number) => Promise<DialsOutcome>;
  stateDir: string;
  uid: number | undefined;
  clock: Clock;
  repoGhId: number;
  /** Gets fixed text only. */
  log: (line: string) => void;
}

/**
 * Keeps the file fresh: `refresh` is one fetch and, only on a good answer, one write. `run` does it now, then every 5 minutes, and sooner when
 * `controlsChanged` is called (the pull's controls differed from the last one). `controlsChanged` is the one hook the daemon wiring (EB-3c) needs.
 */
export class CeilingKeeper {
  private busy: Promise<RefreshResult> | null = null;
  private again = false;
  private wake: (() => void) | null = null;
  private lastResult: RefreshResult | null = null;

  constructor(private readonly deps: CeilingKeeperDeps) {}

  /** What the last refresh did; null before the first. */
  status(): RefreshResult | null {
    return this.lastResult;
  }

  /** One fetch and, on a good answer, one write. Never throws. A refresh asked for while one is running is the same one (single flight). */
  refresh(): Promise<RefreshResult> {
    if (this.busy !== null) {
      this.again = true;
      return this.busy;
    }
    const current = this.attempt().finally(() => {
      this.busy = null;
    });
    this.busy = current;
    return current;
  }

  controlsChanged(): void {
    this.again = true;
    this.wake?.();
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.refresh();
      if (this.again) {
        this.again = false;
        continue;
      }
      const inner = new AbortController();
      const stop = (): void => inner.abort();
      signal.addEventListener("abort", stop, { once: true });
      this.wake = stop;
      try {
        // An abort that came before the listener was added would never be heard: look again now.
        if (signal.aborted) stop();
        await this.deps.clock.sleep(REFRESH_MS, inner.signal);
      } finally {
        this.wake = null;
        signal.removeEventListener("abort", stop);
      }
      this.again = false;
    }
  }

  private async attempt(): Promise<RefreshResult> {
    const { deps } = this;
    const fetchedAt = deps.clock.now();
    let result: RefreshResult = "kept_old";
    let outcome: DialsOutcome | undefined;
    try {
      outcome = await deps.fetchDials(deps.repoGhId);
    } catch {
      // fx-swallow-ok: the error could carry an address or a path; a fixed line is logged and the old file is left to run out
      deps.log("engine-bridge: the dial snapshot could not be fetched; the ceiling file is left as it is");
    }
    if (outcome?.kind === "ok") {
      try {
        writeCeiling(deps.stateDir, buildCeiling(outcome.reply, fetchedAt), deps.uid);
        result = "written";
      } catch {
        // fx-swallow-ok: the error could carry a path; a fixed line is logged and the old file is left to run out
        deps.log("engine-bridge: the ceiling file could not be written; it is left as it is");
      }
    } else if (outcome !== undefined) {
      deps.log("engine-bridge: the dial snapshot could not be fetched; the ceiling file is left as it is");
    }
    this.lastResult = result;
    return result;
  }
}
