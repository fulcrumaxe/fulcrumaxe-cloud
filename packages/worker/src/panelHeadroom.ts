import type { Pool } from "pg";
import { checkHeadroom, type HeadroomParams } from "@fx/spend";
import type { SeatRequest, SeatResult } from "./seat.js";

/**
 * D#483 S5-k1e: "would a spending limit deny this whole panel round?", asked before any seat of the round starts and without writing a run row.
 *
 * Every seat of a round draws on the same account budget, the same item cap and the same spend envelope, so the round is asked as ONE reservation: the seats'
 * estimates (model, compute and envelope floor) added together under the terms they share (brokering, trigger, plan); seats that differ in such a term fail closed. That is the arithmetic `reserve()`
 * will do when the seats start one after another, so a round that would only fit seat by seat is told so before any seat spends. The per-run limit is a limit on one
 * run, so it is asked of each seat on its own (a sum of runs is not a run). Anything that is not a spending limit (`account_not_active`, a seat that cannot be
 * resolved) is answered as it came and the caller decides; this function never turns it into a pause.
 */
export type RoundHeadroom = { ok: true } | { ok: false; reason: string };

/** The answer when the seats of one round are priced under different budget terms: not a spending limit, so the caller starts the seats and each `reserve()` decides alone. */
export const ROUND_TERMS_DIFFER = "round_terms_differ";
/** The fields a round adds up or asks per seat; every other spend field is a term the seats must share. */
const SUMMED_OR_PER_SEAT: ReadonlySet<string> = new Set(["estimateModelUsd", "estimateComputeUsd", "envelopeFloorUsd", "perSpawnCapUsd"]);

export async function checkRoundHeadroom(runnerPool: Pool, resolveRunSeat: (request: SeatRequest) => Promise<SeatResult>, who: { accountId: string; workItemId: string }, roles: readonly string[]): Promise<RoundHeadroom> {
  const seats: Array<Omit<HeadroomParams, "accountId">> = [];
  for (const role of roles) {
    const seat = await resolveRunSeat({ accountId: who.accountId, role, workItemId: who.workItemId });
    if (!seat.ok) return { ok: false, reason: `seat_${seat.reason}` };
    seats.push(seat.seat.spend);
  }
  if (seats.length === 0) return { ok: true };
  for (const spend of seats) {
    const one = await checkHeadroom(runnerPool, { ...spend, accountId: who.accountId });
    if (one.decision === "deny") return { ok: false, reason: one.reason };
  }
  if (seats.length === 1) return { ok: true };
  // The round as a whole, asked as ONE reservation: the estimates added up (model, compute and the envelope floor), the per-run limit lifted (it was asked of each seat
  // above). The account budget, the item cap, the item's envelope and the compute cap are shared by every seat of the round, so they are asked once with the sum and
  // never once per group. Seats must agree on every term that picks which budget applies (brokering, trigger, plan, kind, budget, whether the seat reserves model money);
  // when they do not, one sum would be wrong in either direction, so the round fails closed with its own refusal instead of being split across the shared limits.
  const terms = new Set<string>();
  for (const s of seats) {
    const rest = Object.entries(s).filter(([name]) => !SUMMED_OR_PER_SEAT.has(name));
    rest.push(["reservesModelMoney", String((s.estimateModelUsd ?? 0) > 0)]);
    terms.add(JSON.stringify(rest.sort(([x], [y]) => (x < y ? -1 : 1))));
  }
  if (terms.size > 1) return { ok: false, reason: ROUND_TERMS_DIFFER };
  const sum = (field: "estimateModelUsd" | "estimateComputeUsd" | "envelopeFloorUsd"): number => seats.reduce((total, s) => total + (s[field] ?? 0), 0);
  const whole = await checkHeadroom(runnerPool, {
    ...seats[0]!,
    accountId: who.accountId,
    estimateModelUsd: sum("estimateModelUsd"),
    estimateComputeUsd: sum("estimateComputeUsd"),
    ...(seats.some((s) => s.envelopeFloorUsd !== undefined) && { envelopeFloorUsd: sum("envelopeFloorUsd") }),
    perSpawnCapUsd: Number.MAX_SAFE_INTEGER,
  });
  if (whole.decision === "deny") return { ok: false, reason: whole.reason };
  return { ok: true };
}
