export const PLAN_PATH = ".autonomous-team/roadmap.json";

export function planFile(over: Record<string, Record<string, unknown>> = {}): string {
  const rows: Record<string, Record<string, unknown>> = {
    "D#9:T1": { milestone: "m1", planned_prs: 1, status: "not_started", prs: [] },
    "D#9:T2": { milestone: "m1", planned_prs: 2, status: "in_progress", prs: [21] },
    "D#9:T3": { milestone: "m1", planned_prs: 1, status: "done", prs: [5], note: "history row" },
    "D#9:T4": { milestone: "m1", planned_prs: 1, status: "deferred", prs: [] },
    ...over,
  };
  return `${JSON.stringify({ version: 1, milestones: { m1: { definition: "First.", tasks: Object.keys(rows) } }, task_status: rows }, null, 2)}\n`;
}

export const pull = (number: number, key: string, state: "open" | "merged" | "closed") => ({
  number,
  title: `${key.split(":")[1]}: change`,
  state,
  dLines: [`Closes ${key.split(":")[0]} ${key.split(":")[1]}`],
});

