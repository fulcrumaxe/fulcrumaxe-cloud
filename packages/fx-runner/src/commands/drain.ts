/**
 * `fx-runner drain`: the upgrade path. The running daemon finishes the jobs it holds, claims nothing more and exits 0; this command returns
 * when it has. A plain restart has no safe moment: the daemon claims the next job within a second of finishing one, so a restart "between
 * jobs" kills a run that was only just handed over. After a drain nothing is in hand, so replacing the program loses no run.
 *
 * The daemon is found through the ledger lock (`jobs.ledger.lock` holds its pid), the same file that keeps a second daemon out. With no
 * daemon running nothing is written, so a marker never waits for the next start.
 */
import type { CommandContext } from "../context.js";
import { daemonPid, setDraining } from "../runnerSettings.js";
import { LEDGER_FILE, pidIsAlive, type RunHost } from "./run.js";

const POLL_MS = 1000;

export async function drainCommand(ctx: CommandContext, kill: RunHost["kill"], options: { wait: boolean; pollMs?: number }): Promise<number> {
  const pid = daemonPid(ctx.stateDir, LEDGER_FILE);
  if (pid === undefined || !pidIsAlive(kill, pid)) {
    ctx.out("No fx-runner is running on this state directory; there is nothing to drain. It is safe to upgrade now.");
    return 0;
  }
  setDraining(ctx.stateDir, true);
  if (!options.wait) {
    ctx.out("Drain requested. The runner finishes the jobs it holds, claims nothing more and exits; it is safe to upgrade once it has. Check: fx-runner status");
    return 0;
  }
  ctx.out("Draining: the runner finishes the jobs it holds, claims nothing more and exits. Waiting for it (Ctrl-C stops waiting, not the drain)...");
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  while (pidIsAlive(kill, pid)) await sleep(options.pollMs ?? POLL_MS);
  setDraining(ctx.stateDir, false);
  ctx.out("The runner has stopped with no job in hand. It is safe to upgrade; start it again afterwards (fx-runner run, or your service).");
  return 0;
}
