import type { LedgerOptions } from "../../src/daemon/ledger.js";

/** Whether a process with this pid exists; a process of another user (EPERM) exists. What the daemon's wiring hands the ledger. */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // fx-swallow-ok: the answer is the point: ESRCH is a process that is gone, anything else is one that is there
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** The ledger's options for the test process itself, with a clock if the test wants one. */
export const ledgerOptions = (now?: () => Date): LedgerOptions => ({ pid: process.pid, isAlive: pidIsAlive, ...(now === undefined ? {} : { now }) });
