/**
 * D#845 ON-13c1 (Ruling 98 c): the spend guard in front of a system start. Called once per batch, before anything is signed, with the batch's starts and how many of them would need a hosted sandbox the cloud pays for.
 * At this milestone every placement is a machine the customer runs, so `hosted` is 0 and the answer is ok. Any hosted sandbox is refused, whatever the account or the count: no hosted engine can be created from here.
 */
export type EngineSpendGuardResult = { ok: true } | { ok: false; code: "hosted_engine_unavailable" };

export function engineSessionSpendGuard(input: { accountId: string; starts: number; hosted: number }): EngineSpendGuardResult {
  const { starts, hosted } = input;
  if (!Number.isInteger(starts) || starts < 0 || !Number.isInteger(hosted) || hosted < 0) throw new Error("engineSessionSpendGuard: starts and hosted are counts");
  return hosted > 0 ? { ok: false, code: "hosted_engine_unavailable" } : { ok: true };
}
