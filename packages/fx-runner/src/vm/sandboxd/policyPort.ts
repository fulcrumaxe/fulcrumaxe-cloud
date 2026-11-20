/**
 * The real `PolicyPort` (D#587 B-5b): a sandbox's network policy becomes two host-side listeners on its own vsock directory, the CONNECT proxy
 * (port 5253) and the reverse endpoint (port 5254). `apply` resolves only once both are listening, and the adapter lets nothing run in a session
 * before it does (`ready`), so a command never starts in a VM whose policy is not enforced.
 *
 * What it does not decide: the policy's meaning (the egress files parse it, and refuse every shape they cannot enforce before a socket exists),
 * the directory's safety (they re-check it against the sandbox's gid), or what a guest may send (the endpoints). This file finds the directory and
 * gid the helper reported for the id, always passes that gid, and keeps the listeners' lifetimes in step with the sandbox.
 *
 * Ordering and failure, all of them closed:
 *  - a new policy replaces the old one by closing both listeners FIRST, before anything else is looked up, and then starting new ones. So there is a gap
 *    with nothing listening (a guest gets no egress), never a gap with the old policy still answering, and a lookup that fails (the helper is down, the
 *    sandbox is not listed) leaves nothing listening either;
 *  - if either listener cannot start, the one that did is closed and `apply` throws; the sandbox then has no egress;
 *  - a sandbox the helper does not list has no directory to listen in, so `apply` throws and nothing starts;
 *  - `release` closes both whatever the first one's close does, and is safe to repeat.
 * The egress starters are passed in (their module is another package's work, held to this file by the type check in the test that wires the real ones).
 */
import type { Helper } from "./helperClient.js";

export interface EgressListener { close(): Promise<void> }
export interface EgressStartOptions { vsockDir: string; sandboxId: string; sandboxGid: number; /** The runner's own uid: the listeners accept only a directory this user owns. Supplied by the caller, never read here. */ uid: number; policy: unknown }
export interface EgressStarters {
  startProxy(options: EgressStartOptions): Promise<EgressListener>;
  startReverse(options: EgressStartOptions & { inject?: (host: string) => Record<string, string> | undefined }): Promise<EgressListener>;
}

export interface EgressPolicyPortConfig {
  helper: Pick<Helper, "list">;
  /**
   * The runner's uid, handed to every listener. TODO(B-5 wiring): nothing in this stack builds this port yet; the bin edge that does must pass the real uid
   * (`process.getuid()` is read there, never in `src`). Without a matching uid the listeners refuse the directory, which fails closed.
   */
  uid: number;
  egress: EgressStarters;
  /** Host-side credentials for one sandbox's rewritten hosts; they never reach the guest. */
  inject?: (sandboxId: string) => ((host: string) => Record<string, string> | undefined) | undefined;
}

export class PolicyPortError extends Error {
  constructor(readonly code: "unknown_sandbox" | "no_gid") {
    super(`egress policy port: ${code}`);
    this.name = "PolicyPortError";
  }
}

export function createEgressPolicyPort(config: EgressPolicyPortConfig): { apply(sandboxId: string, policy: unknown): Promise<void>; release(sandboxId: string): Promise<void> } {
  const live = new Map<string, EgressListener[]>();
  const chains = new Map<string, Promise<unknown>>();
  /** One id's apply and release run one at a time, in the order asked. */
  const serial = <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const run = (chains.get(id) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => undefined); // fx-swallow-ok: the caller of `run` gets the error; the chain only needs to know it ended
    chains.set(id, tail);
    void tail.then(() => (chains.get(id) === tail ? chains.delete(id) : undefined));
    return run;
  };

  /** Closes every listener of one id. An entry is kept until its close has resolved, so a close that failed is tried again by the next `release` (or `apply`). */
  async function closeAll(id: string): Promise<void> {
    const listeners = live.get(id) ?? [];
    const results = await Promise.allSettled(listeners.map((l) => l.close()));
    const left = listeners.filter((_, i) => results[i]?.status === "rejected");
    if (left.length === 0) live.delete(id);
    else live.set(id, left);
    const failed = results.find((r) => r.status === "rejected");
    if (failed !== undefined) throw (failed as PromiseRejectedResult).reason;
  }

  return {
    apply: (id, policy) =>
      serial(id, async () => {
        await closeAll(id); // first of all: the old policy stops answering before anything that can fail is tried
        const entry = (await config.helper.list()).find((e) => e.sandboxId === id);
        if (entry === undefined) throw new PolicyPortError("unknown_sandbox");
        if (!Number.isInteger(entry.sandboxGid)) throw new PolicyPortError("no_gid");
        const base: EgressStartOptions = { vsockDir: entry.vsockDir, sandboxId: id, sandboxGid: entry.sandboxGid, uid: config.uid, policy };
        const started: EgressListener[] = [];
        try {
          started.push(await config.egress.startProxy(base));
          const inject = config.inject?.(id);
          started.push(await config.egress.startReverse({ ...base, ...(inject === undefined ? {} : { inject }) }));
        } catch (err) {
          await Promise.allSettled(started.map((l) => l.close()));
          throw err;
        }
        live.set(id, started);
      }),
    release: (id) => serial(id, () => closeAll(id)),
  };
}
