import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { checkStartPair, decideStart, settleStartClick } from "@fx/core/src/decisions/startDecide.js";

/**
 * D#7 start gate, part (b): the stage driver's call into `decideStart`. Runs on the RECEIPT login's pool (the only login that can call the start definers),
 * for an advance a signed-in owner or admin filed (`performDriven` refuses every other). The input's `origin` says whether THIS run was filed by that person
 * (`person_click`) or is a restart nobody clicked (`unattended`: the dial decides, a hold stays, a started pair goes on, and no person receipt is recorded).
 *
 * The workflow sees fixed words only: whether to go on, and if not, why. Nothing from the item (its title, its ask) crosses into the workflow's history.
 */
export type StartGateOrigin = "person_click" | "unattended";
export type StartGateMode = "triage_end" | "light" | "build" | "spec";
export interface StartGateStepInput {
  mode: StartGateMode;
  /** The category triage produced (`triage_end`), or the short Spec's kind (`light`); null at the build and spec entries, where the item's own kind is read. */
  category: string | null;
  /** The category the item came in as, when a trusted label said small, bug or doc (`triage_end` only). */
  cameInAs: string | null;
  /**
   * Who made this advance. `person_click` only when a person's own session filed it in this run (`AdvanceStartArgs.personFiled`); every other entry, a restart by
   * the parked-stage sweep or the slot wake included, is `unattended`: the dial decides, and no person receipt is ever recorded.
   */
  origin: StartGateOrigin;
  /**
   * D#483 S5-b1a-2: the item the dial started (set only on a dial-filed advance, at the end of triage). The category it came in as is then read from that item's
   * own start-gate row, the one the auto-start sweep wrote (decided by the dial, a small, bug or doc type), never from text.
   */
  fromItemId?: string | null;
}
export type StartGateStepOut =
  | { proceed: true; how: string }
  | { proceed: false; reason: "asked" | "held" | "blocked"; blockedBy: string | null };

export type StartGatePort = (who: { accountId: string; userId: string; workItemId: string }, input: StartGateStepInput) => Promise<StartGateStepOut>;

const WORD = /^[a-z][a-z0-9_]{0,63}$/;
const word = (v: string | null): string | null => (v !== null && WORD.test(v) ? v : null);

export function createStartGate(receiptPool: Pool): StartGatePort {
  return async (who, input) => {
    const ctx = { pool: receiptPool, accountId: who.accountId };
    try {
      // Only an advance a person's own session filed is a click. Anything else (a missing or unknown origin included) is unattended: it never records a person receipt.
      const person = input.origin === "person_click";
      if (input.mode === "spec") {
        if (!person) {
          // A restart: the reclassify pair is looked at, not answered. Started or no pair goes on; a hold stays; an open or withdrawn ask is (re)asked.
          const c = await checkStartPair(ctx, { workItemId: who.workItemId });
          return c.proceed ? { proceed: true, how: c.how } : { proceed: false, reason: c.reason, blockedBy: word(c.blockedBy) };
        }
        // The spec entry: a click on an item whose reclassify ask is still open, or was held, answers or decides it again. An item with no such pair goes on.
        const r = await settleStartClick(ctx, { workItemId: who.workItemId, userId: who.userId });
        return { proceed: true, how: r.proceed ? r.how : "unknown" };
      }
      let cameInAs = input.mode === "triage_end" ? input.cameInAs : null;
      if (cameInAs === null && input.mode === "triage_end" && typeof input.fromItemId === "string") {
        const row = await withTenant(receiptPool, who.accountId, (c) =>
          c.query<{ decision_type: string }>(
            `SELECT decision_type FROM start_gate WHERE account_id = $2::uuid AND work_item_id = $1::uuid AND outcome = 'started' AND decided_by = 'policy' AND decision_type IN ('start_work_small', 'start_work_bug', 'start_work_doc')`,
            [input.fromItemId, who.accountId],
          ),
        );
        if (row.rows.length === 1) cameInAs = row.rows[0]!.decision_type.replace("start_work_", "");
      }
      const r = await decideStart(ctx, {
        workItemId: who.workItemId,
        origin: person ? "person_click" : "unattended",
        ...(person ? { userId: who.userId } : {}),
        category: input.mode === "build" ? null : input.category,
        cameInAs,
      });
      return r.proceed ? { proceed: true, how: r.how } : { proceed: false, reason: r.reason, blockedBy: word(r.blockedBy) };
    } catch (err) {
      // A plain member's click is refused by the definer (insufficient_privilege): nothing starts and nothing is recorded.
      if ((err as { code?: string } | null)?.code === "42501") return { proceed: false, reason: "blocked", blockedBy: "start_forbidden" };
      throw err;
    }
  };
}
