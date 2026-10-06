import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { canCreateWork, type WorkEvent } from "@fx/trust";
import { triageIntake, type TriageDeps, type TriageOutcome } from "./triage.js";
import { ownData } from "./ownData.js";

/**
 * D#2 H15b-1: the workflow step that drives triage.
 *
 * This is the ONLY production caller of `triageIntake` (a test pins it), so
 * it is where two C39 rulings are enforced:
 *
 * (c2) H15b-TRUST. In `new` mode the step decides `trusted` itself, by
 * running H07's real `canCreateWork` over the author fields of the stored
 * work event. The step's input has no `trusted` field and the step never
 * reads one, so a `trusted: true` (or `canCreateWork: true`) that a payload
 * carries, as its own property or through the prototype, changes nothing.
 * Every field is read once into a local; a malformed event is untrusted.
 *
 * (b) H15b-PARK. When triage answers `no_discussion` for a work item that is
 * not internal, the step ends normally and records ONE parked row. Nothing
 * is retried: `createDiscussion` under the system principal always makes an
 * internal root, so it cannot help an external item, and nothing before
 * D#71 DS-7 can create an external discussion. The work item is left exactly
 * as it was (still `triaged`; parking is not a stage). The row carries ids
 * and a fixed reason code, never any text from the item.
 *
 * H15b-2 (IDEM). In `new` mode the input carries the `sourceEventId` of the
 * upstream event. It goes to `createDiscussion`, whose unique index keeps one
 * discussion per (account, key), so replaying the step after a crash
 * returns the first discussion and re-runs only the (idempotent) stage
 * move. The panel and the challenge round are `runPanel` (panel.ts).
 */

export type TriageStepInput =
  | {
      mode: "new";
      /** The stored work event. Its author fields feed H07's `canCreateWork`;
       * its `body` becomes the discussion body. */
      event: WorkEvent;
      title: string;
      repoId?: string | null;
      /** The upstream event this intake handles (an id, never content). The
       * database keeps one discussion per (account, key), so replaying the
       * step with the same key after a crash creates nothing new. */
      sourceEventId: string;
    }
  | { mode: "existing"; workItemId: string; title: string; body: string };

export type ParkReason = "external_no_discussion";

export type TriageStepOutcome =
  | TriageOutcome
  | {
      status: "parked";
      reason: ParkReason;
      workItemId: string;
      /** True when this call wrote the record; false when an earlier run of
       * the same intake already had (a replay: nothing was written). */
      recorded: boolean;
    };

export interface ParkedItem {
  workItemId: string;
  reason: ParkReason;
  createdAt: Date;
}

/** Copies the author fields of `event` into a plain object. Each field is
 * read once, and only as an OWN data property: nothing comes from the
 * prototype chain and no getter runs. The allowlist is copied FIRST and the
 * copy is what gets validated and used, so there is no window between a
 * check and a later read (a Proxy or a mutating array cannot show H07 a
 * value that was never validated). Anything malformed returns null: not
 * trusted. */
function snapshotEvent(event: unknown): WorkEvent | null {
  if (event === null || typeof event !== "object") return null;
  const login = ownData(event, "login");
  const repoPermission = ownData(event, "repoPermission");
  const rawAllowlist = ownData(event, "allowlist");
  const allowWritePermission = ownData(event, "allowWritePermission");
  const body = ownData(event, "body");
  if (typeof login !== "string" || typeof repoPermission !== "string" || typeof body !== "string") return null;
  if (!Array.isArray(rawAllowlist)) return null;
  const allowlist: unknown[] = Array.from(rawAllowlist as ArrayLike<unknown>);
  if (!allowlist.every((e): e is string => typeof e === "string")) return null;
  return {
    login,
    repoPermission: repoPermission as WorkEvent["repoPermission"],
    allowlist,
    allowWritePermission: allowWritePermission === true,
    body,
  };
}

async function parkIfExternal(deps: TriageDeps, workItemId: string): Promise<TriageStepOutcome | null> {
  return withTenant(deps.pool, deps.accountId, async (client) => {
    const { rows } = await client.query<{ provenance: unknown }>(`SELECT provenance FROM work_items WHERE id = $1`, [workItemId]);
    if (rows.length === 0) return null;
    // Fail closed, as H07 does: only the exact literal "internal" is internal.
    if (rows[0]!.provenance === "internal") return null;
    const ins = await client.query(
      `INSERT INTO parked_work_items (account_id, work_item_id, reason)
       VALUES ($1, $2, 'external_no_discussion')
       ON CONFLICT (account_id, work_item_id, reason) DO NOTHING
       RETURNING id`,
      [deps.accountId, workItemId],
    );
    return { status: "parked", reason: "external_no_discussion", workItemId, recorded: ins.rowCount === 1 } as const;
  });
}

export async function runTriageStep(deps: TriageDeps, input: TriageStepInput): Promise<TriageStepOutcome> {
  // Read the input once. `mode` and everything after it come from locals.
  // Every field is an OWN data property or absent: nothing comes from the
  // prototype chain (CWE-1321) and no getter runs.
  const raw: object | null = input !== null && typeof input === "object" ? input : null;
  const field = (key: string): unknown => (raw === null ? undefined : ownData(raw, key));
  const mode: unknown = field("mode");

  if (mode === "new") {
    const title = field("title") as string;
    const repoId = (field("repoId") as string | null | undefined) ?? null;
    const sourceEventId = field("sourceEventId") as string;
    const event = snapshotEvent(field("event"));
    // H07's decision, not the payload's. A malformed event is untrusted.
    const trusted = event !== null && canCreateWork(event);
    return triageIntake(deps, { mode: "new", trusted, title, body: event === null ? "" : event.body, repoId, sourceEventId });
  }

  if (mode === "existing") {
    const workItemId = field("workItemId") as string;
    const title = field("title") as string;
    const body = field("body") as string;
    const out = await triageIntake(deps, { mode: "existing", workItemId, title, body });
    if (out.status === "refused" && out.reason === "no_discussion") {
      return (await parkIfExternal(deps, workItemId)) ?? out;
    }
    return out;
  }

  return { status: "refused", reason: "invalid_mode" };
}

/** The parked items of this account, oldest first: what an owner/admin lists. */
export async function listParked(deps: Pick<TriageDeps, "pool" | "accountId">): Promise<ParkedItem[]> {
  const pool: Pool = deps.pool;
  return withTenant(pool, deps.accountId, async (client) => {
    const { rows } = await client.query<{ work_item_id: string; reason: ParkReason; created_at: Date }>(
      `SELECT work_item_id, reason, created_at FROM parked_work_items ORDER BY created_at, id`,
    );
    return rows.map((r) => ({ workItemId: r.work_item_id, reason: r.reason, createdAt: r.created_at }));
  });
}
