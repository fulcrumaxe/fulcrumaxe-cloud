/**
 * D#597 CC-7a-2: the assistant's read tools and the one cloud GET each makes. The names are the hosted assistant's (`get_item`, `get_run_activity`,
 * `get_plan`); `get_run`, `get_run_events` and `get_receipts` have no hosted twin yet. Every tool is a GET of a route the delegation token may read
 * for its own repo, and the arguments are checked here, so a path is built only from a validated id or a small fixed query. The repo of `get_plan`
 * is the token's own (it takes no repo argument). There is no write, accept or stage-verb entry.
 */
export const READ_TOOLS: readonly string[] = Object.freeze(["get_item", "get_run_activity", "get_run", "get_run_events", "get_plan", "get_receipts"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Kind = "id" | "digits" | "milestone" | "plan_status";
const KIND_OK: Record<Kind, (v: string) => boolean> = {
  id: (v) => UUID.test(v),
  digits: (v) => /^[0-9]{1,12}$/.test(v),
  milestone: (v) => v.length >= 1 && Array.from(v).length <= 80 && !/\p{Cc}/u.test(v),
  plan_status: (v) => v === "done" || v === "remaining",
};
interface Shape {
  fields: Record<string, Kind>;
  required: readonly string[];
  build(a: Record<string, string>, repoId: string): string;
}
const SHAPES: Record<string, Shape> = {
  get_item: { fields: { item_id: "id" }, required: ["item_id"], build: (a) => `/api/v1/work-items/${a.item_id}` },
  get_run_activity: { fields: { item_id: "id" }, required: ["item_id"], build: (a) => `/api/v1/runs?work_item_id=${a.item_id}&limit=20` },
  get_run: { fields: { run_id: "id" }, required: ["run_id"], build: (a) => `/api/v1/runs/${a.run_id}` },
  get_run_events: {
    fields: { run_id: "id", after_seq: "digits" },
    required: ["run_id"],
    build: (a) => `/api/v1/runs/${a.run_id}/events?limit=50${a.after_seq === undefined ? "" : `&after_seq=${a.after_seq}`}`,
  },
  get_plan: {
    fields: { milestone: "milestone", status: "plan_status" },
    required: [],
    build: (a, repoId) => `/api/v1/repos/${repoId}/plan?limit=40${a.milestone === undefined ? "" : `&milestone=${encodeURIComponent(a.milestone)}`}${a.status === undefined ? "" : `&status=${a.status}`}`,
  },
  get_receipts: { fields: { item_id: "id" }, required: ["item_id"], build: (a) => `/api/v1/work-items/${a.item_id}/receipts` },
};

/** The argument names each read tool takes (read from the shapes above), for the name cross-check against the hosted registry. */
export const READ_TOOL_ARGS: Readonly<Record<string, readonly string[]>> = Object.freeze(Object.fromEntries(Object.entries(SHAPES).map(([name, s]) => [name, Object.keys(s.fields)])));

/** The route path for a validated call, or the first fault in fixed words (never the input's own text). */
export function readPath(tool: string, args: Record<string, unknown>, repoId: string): { path: string } | { fault: string } {
  const shape = Object.hasOwn(SHAPES, tool) ? SHAPES[tool] : undefined;
  if (shape === undefined || !UUID.test(repoId)) return { fault: "that read is not available" };
  const given: Record<string, string> = {};
  for (const [name, value] of Object.entries(args)) {
    const kind = Object.hasOwn(shape.fields, name) ? shape.fields[name] : undefined;
    if (kind === undefined) return { fault: "the call has a field this tool does not take" };
    if (typeof value !== "string" || !KIND_OK[kind](value)) return { fault: `${name} is not valid` };
    given[name] = value;
  }
  for (const name of shape.required) if (!Object.hasOwn(given, name)) return { fault: `${name} is required` };
  return { path: shape.build(given, repoId) };
}
