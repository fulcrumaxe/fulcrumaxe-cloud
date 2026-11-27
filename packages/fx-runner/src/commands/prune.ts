/**
 * `fx-runner prune [--dry-run]` (D#587 FU-318): removes the workspaces of finished runs that nothing has touched for the retention (7 days; 1 day while the
 * disk has under 10% free; `config set workspace-retention-days`). The running runner does the same by itself every hour. `--dry-run` lists what would go and deletes nothing.
 *
 * A real prune is refused while a runner is running on this state directory: its own memory of which runs it holds is the only complete answer, and it already
 * prunes on a timer. The list it keeps for this command is enough for a dry run, never for a delete. A list that cannot be read is "everything is held".
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { CliError } from "../cliError.js";
import type { CommandContext } from "../context.js";
import { LedgerLockedError, releaseLock, takeLock } from "../daemon/ledger.js";
import { cacheRootsFor } from "../daemon/mirror.js";
import { createLiveWorkspaces, formatBytes, pruneWorkspaces, readLiveFile, type PruneReport } from "../job/workspacePrune.js";
import { daemonPid, loadSettings } from "../runnerSettings.js";
import { LEDGER_FILE, pidIsAlive, type RunHost } from "./run.js";

export function pruneLines(report: PruneReport): string[] {
  const lines: string[] = [];
  const pressure = report.pressure ? " (disk is under 10% free: 1 day)" : "";
  if (report.rootMissing === true) return ["No workspaces directory yet; nothing to prune."];
  if (report.rootRefused === true) return ["The workspaces directory is not a plain directory of yours; nothing was touched."];
  lines.push(`${report.dryRun ? "Would remove" : "Removed"} ${report.removed.length} workspace${report.removed.length === 1 ? "" : "s"} idle for ${report.retentionDays}+ days${pressure}, ${formatBytes(report.bytesFreed)}.`);
  if (report.finishedLeftovers > 0) lines.push(`Finished deleting ${report.finishedLeftovers} workspace${report.finishedLeftovers === 1 ? "" : "s"} an earlier prune had stopped on.`);
  for (const e of report.removed) lines.push(`  ${e.name}  ${formatBytes(e.bytes)}  idle ${e.idleDays}d`);
  const live = report.kept.filter((k) => k.reason === "live").length;
  const recent = report.kept.filter((k) => k.reason === "recent").length;
  lines.push(`Kept: ${recent} recent, ${live} in use, ${report.kept.length - recent - live} not made by the runner or not removable.`);
  if (report.failed.length > 0) lines.push(`${report.failed.length} could not be removed; they are tried again next time.`);
  return lines;
}

export async function pruneCommand(ctx: CommandContext, flags: ReadonlyMap<string, string | true>, host: { home: string | undefined; platform: NodeJS.Platform; xdgCacheHome?: string | undefined; kill: RunHost["kill"]; /** A test seam for the free fraction of the disk; read from the disk when absent. */ freeFraction?: number; /** This process's pid, written into the single-instance lock. */ pid: number; /** A test seam passed to the pass. */ afterJudged?: (dir: string) => Promise<void> }): Promise<number> {
  if (host.home === undefined) throw new CliError("prune cannot find your home directory");
  const dryRun = flags.has("dry-run");
  const { workspaceRoot } = cacheRootsFor({ home: host.home, platform: host.platform, xdgCacheHome: host.xdgCacheHome });
  const pid = daemonPid(ctx.stateDir, LEDGER_FILE);
  const running = pid !== undefined && pidIsAlive(host.kill, pid);
  if (running && !dryRun) throw new CliError("a runner is running on this machine and prunes by itself every hour; stop it (fx-runner drain) to prune now, or use --dry-run to list", 1);
  const live = createLiveWorkspaces();
  if (running) {
    const saved = readLiveFile(ctx.stateDir);
    if (saved === undefined) throw new CliError("the running runner's list of workspaces in use cannot be read, so nothing can be judged; try again in a moment", 1);
    for (const name of saved) live.hold(name);
  }
  // A real prune holds the runner's single-instance lock for its whole length: a runner that starts meanwhile (the unit restarts a crashed one within seconds) is refused
  // and retried by its unit, so it can never resume a workspace this prune is deleting. The lock is released whatever happens.
  const myPid = host.pid;
  const lock = path.join(ctx.stateDir, `${LEDGER_FILE}.lock`);
  let locked = false;
  if (!dryRun) {
    mkdirSync(ctx.stateDir, { recursive: true, mode: 0o700 });
    try {
      takeLock(lock, myPid, (other) => pidIsAlive(host.kill, other), ctx.now);
      locked = true;
    } catch (error) {
      if (error instanceof LedgerLockedError) throw new CliError("another fx-runner process is using this state directory, so nothing was pruned; try again when it has finished", 1);
      throw error;
    }
  }
  try {
    const report = await pruneWorkspaces({
      root: workspaceRoot,
      now: ctx.now(),
      retentionDays: loadSettings(ctx.stateDir).workspaceRetentionDays,
      live,
      dryRun,
      ...(host.freeFraction === undefined ? {} : { freeFraction: host.freeFraction }),
      ...(host.afterJudged === undefined ? {} : { afterJudged: host.afterJudged }),
      isAlive: (other) => pidIsAlive(host.kill, other),
    });
    for (const line of pruneLines(report)) ctx.out(line);
    return 0;
  } finally {
    if (locked) releaseLock(lock, myPid);
  }
}
