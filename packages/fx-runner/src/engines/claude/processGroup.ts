/** The part of a child process this file uses (a structural type, so this file needs no process-spawning import). */
interface Killable {
  pid?: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** How long a signalled agent gets to exit before everything left in its process group is killed. */
export const DEFAULT_KILL_GRACE_MS = 3000;

/** The agent starts as the leader of its own process group, except where there are no process groups to signal. */
export const OWN_PROCESS_GROUP = process.platform !== "win32";

function signalGroup(child: Killable, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!OWN_PROCESS_GROUP || pid === undefined) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // fx-swallow-ok: the group is already gone (ESRCH), which is the state a stop wants
  }
}

function groupAlive(child: Killable): boolean {
  const pid = child.pid;
  if (!OWN_PROCESS_GROUP || pid === undefined) return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    // fx-swallow-ok: no member left in the group
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ends the agent and everything it started that is still in its process group: SIGTERM to the group now, SIGKILL to
 * whatever is left once `graceMs` has passed. Resolves when the group is empty. A tool call's background process
 * shares the agent's group, so it cannot outlive the job.
 */
export async function terminateGroup(child: Killable, graceMs: number): Promise<void> {
  signalGroup(child, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (groupAlive(child) && Date.now() < deadline) await sleep(25);
  if (groupAlive(child)) signalGroup(child, "SIGKILL");
}
