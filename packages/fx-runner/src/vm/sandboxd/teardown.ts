/**
 * Global teardown for the VM engine's tests and for a daemon that is shutting down (D#587 B-2b-iii-b): every id the daemon ever asked the
 * helper to prepare is stopped and destroyed, and then no Firecracker process may be left on the host. Bounded: each sandbox gets
 * `perSandboxMs`, run in parallel, so a silent guest delays the end by that much at most and never hangs it.
 */
import type { Sandboxd } from "./sandboxd.js";

/** Counts live processes by name. The real counter is built by the caller (outside `src`) and passed in; a test hands it a fake. */
export interface ProcessLister {
  count(name: string): Promise<number>;
}

export class TeardownError extends Error {
  constructor(readonly leftover: string[], readonly processes: number) {
    super(`fx-sandboxd teardown: ${leftover.length} sandbox(es) not destroyed, ${processes} firecracker process(es) alive`);
    this.name = "TeardownError";
  }
}

export interface TeardownReport { destroyed: string[]; processes: 0 }

const bounded = async (work: Promise<boolean>, ms: number): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)))]);
  } catch {
    // fx-swallow-ok: a sandbox that cannot be torn down is reported in `leftover`, which is the outcome the caller sees
    return false;
  } finally {
    clearTimeout(timer);
  }
};

export async function globalTeardown(daemon: Sandboxd, lister: ProcessLister, opts: { perSandboxMs?: number } = {}): Promise<TeardownReport> {
  const ids = [...daemon.registered];
  const gone = await Promise.all(ids.map((id) => bounded(daemon.teardown(id), opts.perSandboxMs ?? 60_000)));
  const leftover = ids.filter((_, i) => !gone[i]);
  const processes = await lister.count("firecracker");
  if (leftover.length > 0 || processes !== 0) throw new TeardownError(leftover, processes);
  return { destroyed: ids, processes: 0 };
}
