import type { Pool } from "pg";
import { gateFixRound } from "@fx/core/src/decisions/fixRoundGate.js";

/**
 * D#483 S5-b2a part 2: the stage driver's call into the fix-round gate, on the RECEIPT login's pool (the only login that can call the definers). It gates a REVIEW
 * fix round that nobody asked for with Request changes, and a CHECK fix round (the failed run it resumes is named); a person's own fix round never calls it, and neither does a continuation of a run that hit a limit.
 *
 * The workflow sees fixed words only: whether to go on, and if not, why. Nothing from the item crosses into the workflow's history.
 */
export interface FixGateStepInput {
  /** True when a signed-in person's own session filed this advance (`AdvanceStartArgs.personFiled`). Only after a hold on the same round does that count as the answer. */
  personFiled: boolean;
  /** Set for a CHECK fix round: the failed (`check_failed`) executor run it would resume. Absent: a review fix round. */
  checkFailedRunId?: string;
}
export type FixGateStepOut =
  | { proceed: true; how: string; announce: boolean }
  | { proceed: false; reason: "asked" | "blocked"; blockedBy: string | null };

export type FixGatePort = (who: { accountId: string; userId: string; workItemId: string }, input: FixGateStepInput) => Promise<FixGateStepOut>;

const WORD = /^[a-z][a-z0-9_]{0,63}$/;
const word = (v: string | null): string | null => (v !== null && WORD.test(v) ? v : null);

export function createFixGate(receiptPool: Pool): FixGatePort {
  return async (who, input) => {
    const r = await gateFixRound({ pool: receiptPool, accountId: who.accountId }, { workItemId: who.workItemId, personUserId: input.personFiled === true ? who.userId : null, ...(input.checkFailedRunId === undefined ? {} : { checkFailedRunId: input.checkFailedRunId }) });
    return r.proceed ? { proceed: true, how: r.how, announce: r.announce } : { proceed: false, reason: r.reason, blockedBy: word(r.blockedBy) };
  };
}
