/**
 * The shape of the `agent.activity` run_events row a runner run writes and the run stream delivers. The runner's writer test and the
 * api stream test each check their row against this one function, so a change to either side fails there instead of passing silently.
 */
export const ACTIVITY_ROW_KIND = "agent.activity";
const ACTIVITY_TOOLS = ["read", "list", "search", "test", "command"];
const ACTIVITY_KEYS = ["tool", "path", "pattern", "command"];

/** Null when the row is a well-formed activity row; otherwise a short reason. */
export function activityRowProblem(row: { kind: string; payload: unknown }): string | null {
  if (row.kind !== ACTIVITY_ROW_KIND) return "kind is " + row.kind;
  const p = row.payload;
  if (typeof p !== "object" || p === null || Array.isArray(p)) return "payload is not an object";
  const keys = Object.keys(p);
  const stray = keys.find((k) => !ACTIVITY_KEYS.includes(k));
  if (stray !== undefined) return "unexpected payload key " + stray;
  const rec = p as Record<string, unknown>;
  if (typeof rec.tool !== "string" || !ACTIVITY_TOOLS.includes(rec.tool)) return "tool is not one of " + ACTIVITY_TOOLS.join(", ");
  if (keys.some((k) => typeof rec[k] !== "string")) return "a payload value is not a string";
  return null;
}
