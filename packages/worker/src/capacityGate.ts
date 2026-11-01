import type { Pool, PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { DispatchFailedError, providerCapacityOf, readRunSide, type StartAgentRunInput } from "@fx/runner";
import { checkHeadroom } from "@fx/spend";

/**
 * D#483 S5-k3b-2c: the capacity gate, the ONE place that may refuse a start because our hosted sandbox slots are used up (S5k3b-11 reads this file's name). Our own capacity never
 * refuses, stops or fails a customer's work: a start that finds no room answers `waiting_for_capacity` and the item waits in the queue (packages/pipeline capacityQueue.ts, behind the
 * `CapacityPort` the composition root injects; the worker cannot import the queue helper). With no port, starts are exactly what they were.
 *
 * The gate wraps the run starter and the fix-round resume, so every start site (classify, Spec, re-spec, reviewers, build, the parked-decision resume, the merge queue's delta review, fix
 * rounds and check-fix rounds) meets it without a second copy of the order. C23 item 3's order:
 *   1. a key that already holds a run is a replay and passes through untouched;
 *   2. anything but a sandbox run passes through (runner runs already wait as pending);
 *   3. rule 1 first: the read-only spend check. A deny goes to the starter as today (refused and keyed `refused_spend`) and is never queued;
 *   4. a held claim is consumed, in the run's create transaction (`capacity_mark_started`; a lost claim rolls the run back and the order runs again);
 *   5. no waiting entry and headroom: the item starts directly; otherwise it is queued, one claim pass runs, and the answer is `waiting_for_capacity`.
 * A provider 429 on the create ends the attempt `cancelled` / `provider_capacity` (the runner); the entry goes back with its place and the item waits.
 */

/** The refusal that means "our servers are full, ask again". Equal to `CAPACITY_WAIT` in packages/pipeline reservationPauses.ts (a test holds the two together). */
export const CAPACITY_WAIT = "waiting_for_capacity";

/** Thrown out of a wrapped start when the item must wait. The start sites turn it into `{ ok: false, reason: "waiting_for_capacity" }`. */
export class CapacityWaitingError extends Error {
  constructor() {
    super(CAPACITY_WAIT);
    this.name = "CapacityWaitingError";
  }
}

/** The run's create transaction found its claim gone (another ask took it, or a cancel ended the entry): nothing was written, and the order runs again. */
export class CapacityClaimLostError extends Error {
  constructor() {
    super("the capacity claim was lost");
    this.name = "CapacityClaimLostError";
  }
}

/** The refusals that mean the repository or its installation is no longer connected. An item with a waiting entry keeps waiting on these (it starts when the repository is connected again). */
export const REPO_GONE_REFUSALS: readonly string[] = Object.freeze(["no_repo", "no_installation", "installation_not_writable"]);

export interface CapacityAdmit {
  accountId: string;
  repoId: string;
  workItemId: string;
  runKind: string;
}

export type CapacityDecision = { kind: "start" } | { kind: "claimed"; entryId: string; attempt: number } | { kind: "wait" };

export interface CapacityPort {
  /** Whether the item has an open entry that has not started. */
  holds(accountId: string, workItemId: string): Promise<boolean>;
  /** C23 item 3, cases 4 to 6: consume a held claim, start directly, or queue. */
  admit(input: CapacityAdmit): Promise<CapacityDecision>;
  /** A start the provider refused with 429: the claimed entry goes back (same place, next attempt), or a direct start is queued. Then the item waits. */
  refused(input: CapacityAdmit & { runId: string; entryId: string | null; status: number; code: string | null }): Promise<void>;
}

const ATTEMPTS = 3;

export function createCapacityGate(pool: Pool, port: CapacityPort) {
  /** Whether a key already holds a run (a replay). */
  async function replays(accountId: string, key: string | undefined): Promise<boolean> {
    if (key === undefined) return false;
    return withTenant(pool, accountId, async (client) => (await client.query("SELECT 1 FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = $2", [accountId, key])).rowCount === 1);
  }

  return {
    /** Runs `start` for `input` under the gate. Throws `CapacityWaitingError` when the item must wait. */
    async run<R>(input: StartAgentRunInput, start: (input: StartAgentRunInput) => Promise<R>): Promise<R> {
      if (!input.workItemId || !input.repoId) return start(input);
      const who: CapacityAdmit = { accountId: input.accountId, repoId: input.repoId, workItemId: input.workItemId, runKind: input.role.replace(/[^a-z0-9]+/gi, "_").toLowerCase() };
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        if (await replays(input.accountId, input.idempotency?.key)) return start(input);
        const side = await readRunSide(pool, input.accountId, input.repoId, input.workItemId).catch(() => null);
        if (side === null || side.mode !== "sandbox") return start(input);
        const headroom = await checkHeadroom(pool, { accountId: input.accountId, ...input.spend });
        if (headroom.decision === "deny") return start(input);
        const decision = await port.admit(who);
        if (decision.kind === "wait") throw new CapacityWaitingError();
        const claim = decision.kind === "claimed" ? decision : null;
        const before = input.inCreateTransaction;
        try {
          return await start(
            claim === null
              ? input
              : {
                  ...input,
                  inCreateTransaction: async (client: PoolClient, runId: string) => {
                    const { rows } = await client.query<{ ok: boolean }>("SELECT capacity_mark_started($1, $2, $3) AS ok", [claim.entryId, claim.attempt, runId]);
                    if (rows[0]?.ok !== true) throw new CapacityClaimLostError();
                    await before?.(client, runId);
                  },
                },
          );
        } catch (err) {
          if (err instanceof CapacityClaimLostError) continue;
          const full = err instanceof DispatchFailedError && err.failureReason === "provider_capacity" ? providerCapacityOf(err.originalError) : null;
          if (full === null || !(err instanceof DispatchFailedError)) throw err;
          await port.refused({ ...who, runId: err.runId, entryId: claim?.entryId ?? null, status: 429, code: full.code ?? null });
          throw new CapacityWaitingError();
        }
      }
      // The claim was lost three times running: the item waits and asks again.
      throw new CapacityWaitingError();
    },
  };
}
