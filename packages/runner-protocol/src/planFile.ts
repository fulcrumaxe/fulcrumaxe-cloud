/**
 * D#845 ON-8c: the plan file a runner fetches for a `project_setup` job (`GET setupPlanPath`). The body is `canonicalJson(PlanFile)`; the job's `plan_ref.sha256` is the sha256 of those exact bytes, so a runner
 * hashes the bytes first and parses them only after the hash holds. Strict at every depth: an extra key, a row that depends on a row that is not there, or a repeated row key is refused, never passed on.
 */
import { z } from "zod";

/** The most the plan route answers with, in bytes. */
export const MAX_PLAN_BYTES = 1024 * 1024;
export const MAX_PLAN_ROWS = 200;
export const setupPlanPath = (setupId: string, version: number): string => `/api/runner/setup/${setupId}/plan?version=${version}`;

const strict = <S extends z.ZodRawShape>(shape: S) => z.object(shape).strict();
const ROW_KEY = /^[A-Z][A-Z0-9-]{0,15}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** Text that lands in a heading or a one-line field: no line break and no tab, nor any other control character. */
const ONE_LINE = /^[^\u0000-\u001F\u007F\u0085\u2028\u2029]*$/;
/** A branch name under git's own rules, kept stricter: no leading `-` or `/`, no `..`, `@{`, `//`, trailing `/` or `.`, no `.lock` ending, no segment starting with `.`, and only plain characters (no whitespace, control or `~^:?*[\` character). */
const BRANCH_REF = /^(?!-)(?!\/)(?!.*(?:\.\.|@\{|\/\/|\/$|\.$|\.lock$|\/\.|\.lock\/))(?!@$)(?!\.)[A-Za-z0-9._\-/+#=%,]{1,200}$/;
const NO_CONTROLS = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/;

export const PlanRow = strict({
  row_key: z.string().regex(ROW_KEY),
  title: z.string().min(1).max(120).regex(ONE_LINE),
  summary: z.string().max(500).regex(NO_CONTROLS),
  size: z.enum(["S", "M", "L"]),
  depends_on: z.array(z.string().regex(ROW_KEY)).max(10),
});
export type PlanRow = z.infer<typeof PlanRow>;

export const PlanFile = strict({
  v: z.literal(1),
  draft_id: z.string().uuid(),
  version: z.number().int().safe().min(1),
  prd_md: z.string().min(1).max(200_000),
  roadmap: z.array(PlanRow).max(MAX_PLAN_ROWS),
  setup: strict({
    kind: z.enum(["existing", "new"]),
    repo_owner: z.string().regex(GITHUB_LOGIN),
    repo_name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
    default_branch: z.string().regex(BRANCH_REF),
    visibility: z.enum(["public", "private"]),
    boss_github_username: z.string().regex(GITHUB_LOGIN),
  }),
}).superRefine((plan, ctx) => {
  const keys = new Set(plan.roadmap.map((row) => row.row_key));
  if (keys.size !== plan.roadmap.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a row key repeats", path: ["roadmap"] });
  plan.roadmap.forEach((row, i) => {
    if (row.depends_on.some((key) => !keys.has(key) || key === row.row_key)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a row depends on a row that is not kept, or on itself", path: ["roadmap", i, "depends_on"] });
  });
});
export type PlanFile = z.infer<typeof PlanFile>;
