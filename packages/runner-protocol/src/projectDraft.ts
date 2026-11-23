import { z } from "zod";
import { MAX_ENVELOPE_INPUT_BYTES } from "./envelope.js";
import { redactText } from "./redact.js";

/**
 * D#845 ON-10a: the survey. A `survey` task is an ordinary agent run of this role, never a machine job (it makes a model call and has a run row, a lease and an activity log).
 * Its one output is `ProjectDraft`, the answer the runner sends as `DoneMessage.agentOutput`. The runner and the cloud both import this file and the CLOUD's parse is the authority.
 */
export const SURVEY_ROLE = "project-surveyor";
/** The most a survey run may take on the machine; the cloud's own deadline is this plus a grace (ON-10b). */
export const SURVEY_MAX_RUN_MS = 20 * 60_000;
/** The codes the cloud writes on a failed survey. They are not part of the runner's progress vocabulary: a runner can never report them. */
export const SURVEY_FAILURE_CODES = ["survey_failed", "survey_timeout"] as const;
export const SURVEY_FAILURE_REASONS = ["output_invalid", "output_too_large", "no_output", "workspace_written", "run_failed", "runner_lost", "refused_at_admit", "cancelled", "deadline"] as const;
export type SurveyFailureReason = (typeof SURVEY_FAILURE_REASONS)[number];

/** The most a PRD may hold: the public markdown renderer's cap (`MAX_MARKDOWN_BYTES` of apps/_lib/markdown.js, held equal by a test), so a draft always shows uncut. */
export const MAX_PRD_BYTES = 64 * 1024;
export const MAX_ROADMAP_ROWS = 200;
const KEY = /^[A-Z][A-Z0-9-]{0,15}$/;
// The same grammar as the database's project_roadmap_valid, which counts characters (code points), not UTF-16 units.
const chars = (s: string): number => [...s].length;
// NUL cannot be stored, and a C0 control is never text a person wrote: only tab and newline pass, and `\r\n` is read as `\n`.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const text = (s: string): boolean => !LONE_SURROGATE.test(s) && !CONTROL.test(s);

const Row = z
  .object({
    row_key: z.string().regex(KEY),
    title: z.string().refine((s) => chars(s) >= 1 && chars(s) <= 120 && text(s) && !/[\t\n]/.test(s)),
    summary: z.string().refine((s) => chars(s) <= 500 && text(s)),
    size: z.enum(["S", "M", "L"]),
    depends_on: z.array(z.string().regex(KEY)).max(10),
  })
  .strict();

function resolves(rows: readonly z.infer<typeof Row>[]): boolean {
  const deps = new Map(rows.map((r) => [r.row_key, r.depends_on] as const));
  if (deps.size !== rows.length) return false;
  for (const [key, list] of deps) if (list.some((d) => d === key || !deps.has(d))) return false;
  // Acyclic: peel the rows whose dependencies are all peeled; whatever is left sits on a cycle.
  const left = new Map(deps);
  for (let moved = true; moved && left.size > 0; ) {
    moved = false;
    for (const [key, list] of left) {
      if (!list.every((d) => !left.has(d))) continue;
      left.delete(key);
      moved = true;
    }
  }
  return left.size === 0;
}

export const ProjectDraft = z
  .object({
    v: z.literal(1),
    prd_md: z.string().transform((s) => s.replace(/\r\n/g, "\n")).refine((s) => s.length >= 1 && Buffer.byteLength(s, "utf8") <= MAX_PRD_BYTES && text(s)),
    roadmap: z.array(Row).min(1).max(MAX_ROADMAP_ROWS),
  })
  .strict()
  .refine((d) => resolves(d.roadmap) && Buffer.byteLength(JSON.stringify(d), "utf8") <= MAX_ENVELOPE_INPUT_BYTES);
export type ProjectDraft = z.infer<typeof ProjectDraft>;

export type SurveyRead = { ok: true; draft: ProjectDraft } | { ok: false; reason: Extract<SurveyFailureReason, "no_output" | "output_invalid" | "output_too_large"> };

/**
 * What the cloud makes of a survey run's `agentOutput`: the run path's redactor over the PRD, each title and each summary FIRST, then the strict parse. Nothing of a refused answer is returned, only a closed reason.
 * `redact` is the redactor (`redactText` with no known secrets by default).
 */
export function readSurveyOutput(output: unknown, redact: (s: string) => string = (s) => redactText(s, [])): SurveyRead {
  if (output === undefined || output === null) return { ok: false, reason: "no_output" };
  if (typeof output !== "object" || Array.isArray(output)) return { ok: false, reason: "output_invalid" };
  const o = output as Record<string, unknown>;
  const clean = (v: unknown): unknown => (typeof v === "string" ? redact(v) : v);
  const roadmap = Array.isArray(o.roadmap) ? o.roadmap.map((r) => (r !== null && typeof r === "object" && !Array.isArray(r) ? { ...r, title: clean((r as Record<string, unknown>).title), summary: clean((r as Record<string, unknown>).summary) } : r)) : o.roadmap;
  const redacted = { ...o, prd_md: clean(o.prd_md), roadmap };
  if (typeof redacted.prd_md === "string" && Buffer.byteLength(redacted.prd_md, "utf8") > MAX_PRD_BYTES) return { ok: false, reason: "output_too_large" };
  const parsed = ProjectDraft.safeParse(redacted);
  return parsed.success ? { ok: true, draft: parsed.data } : { ok: false, reason: "output_invalid" };
}
