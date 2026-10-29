import { workItemBuildSpendUsd } from "@fx/spend";
import type { LedgerPort } from "../ports.js";

/** The pool the spend read takes, named from the function so this package declares no `pg` dependency of its own. */
type SpendPool = Parameters<typeof workItemBuildSpendUsd>[0];

/** The real LedgerPort (D#7 DP7-2c): a read-only view of `ledger` through @fx/spend, tenant-scoped by `withTenant`. */
export function createLedgerPort(pool: SpendPool): LedgerPort {
  return { workItemBuildSpendUsd: (accountId, workItemId) => workItemBuildSpendUsd(pool, accountId, workItemId) };
}
