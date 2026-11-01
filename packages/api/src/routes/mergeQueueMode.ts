import type { Pool } from "pg";
import { getRepo } from "@fx/core/src/repos/read.js";

/** D#694 B7-2: what the Repos screen shows about the repository's merge queue. Derived on every read, never stored; `unreadable` is never `off`. */
export type MergeQueueState = "on" | "off" | "unreadable";

export interface MergeQueueModeReader {
  /** Asks GitHub about the repo's default branch (the reader caches the answer); it answers `unreadable` for anything it could not tell. */
  read(args: { accountId: string; repoId: string }): Promise<MergeQueueState>;
}

/** Set by the app (the `/api/v1` catch-all). With none set, every read is `unreadable`. */
export const mergeQueueModeDeps: { getReader: () => MergeQueueModeReader | null } = { getReader: () => null };

export async function readMergeQueueState(ctx: { pool: Pool; principal: { accountId: string; userId: string } }, repoId: string): Promise<MergeQueueState> {
  try {
    const reader = mergeQueueModeDeps.getReader();
    if (reader === null || (await getRepo(ctx, repoId)).installState !== "installed") return "unreadable";
    const state = await reader.read({ accountId: ctx.principal.accountId, repoId });
    return state === "on" || state === "off" ? state : "unreadable";
  } catch {
    // fx-swallow-ok: a read that failed is shown as "could not be read", never as off; the reader's own text is not passed on
    return "unreadable";
  }
}
