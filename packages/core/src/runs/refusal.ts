/**
 * A run refused before it started keeps its stored status `refused_spend`; the fixed code that says why is on its newest `run.status_changed` event.
 * One definition for the runs read and the item activity: the SQL (refused runs only), the word pattern, and the field that goes into the DTO.
 */
export const REFUSAL_REASON_SQL = `CASE WHEN status = 'refused_spend' THEN (SELECT left(e.payload->>'failureReason', 49) FROM run_events e WHERE e.run_id = agent_runs.id AND e.kind = 'run.status_changed' AND e.payload ? 'failureReason' ORDER BY e.seq DESC LIMIT 1) END AS refusal_reason`;

/** The code is a fixed word from the runner's closed set; anything else is dropped rather than shown. */
export const REFUSAL_CODE_RE = /^[a-z][a-z0-9_]{0,47}$/;

export function refusalField(reason: string | null): { failure_reason?: string } {
  return reason !== null && REFUSAL_CODE_RE.test(reason) ? { failure_reason: reason } : {};
}
