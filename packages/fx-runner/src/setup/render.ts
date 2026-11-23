/**
 * D#845 ON-8c: what the host writes from an approved plan, deterministically: the same plan and the same engine release give the same bytes, so a re-run gives the same install commit. Pure; nothing
 * here reads a clock, a path or the environment.
 *   docs/PRD.md                   the plan's PRD, with LF line ends and one final newline
 *   .autonomous-team/roadmap.json one milestone (`M1`) listing the kept rows; every row is `not-started`, `planned_prs` is 1, 2 or 3 for size S, M or L; keys sorted, two-space indent
 *   epics/NN-<key>.md             one file per kept row in plan order (`NN` is the 1-based position, at least two digits): the engine's epic template headings, in the template's order
 * and the host's part of the coldstart answers (the cloud-known topics of the ruled answer map; the stack topic of an existing project is filled in the guest from the engine's own scan).
 */
import { canonicalJson, type PlanFile } from "@fulcrumaxe/runner-protocol";

export interface RenderedFile {
  path: string;
  content: string;
}

/** The `## ` headings of the engine's epic template, in order. Headings inside a code fence or an HTML comment are not headings. */
export function epicHeadings(epicMd: string): string[] {
  const headings: string[] = [];
  let fence = false;
  let comment = false;
  for (const line of epicMd.replace(/\r\n?/g, "\n").split("\n")) {
    if (comment) {
      if (line.includes("-->")) comment = false;
      continue;
    }
    if (line.startsWith("<!--") && !line.includes("-->")) comment = true;
    else if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence && /^## \S/.test(line)) headings.push(line.slice(3).trim());
  }
  return headings;
}

const PLANNED_PRS = { S: 1, M: 2, L: 3 } as const;
const pretty = (value: unknown): string => `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`;

export function renderPlanFiles(plan: PlanFile, headings: readonly string[]): RenderedFile[] {
  const files: RenderedFile[] = [{ path: "docs/PRD.md", content: `${plan.prd_md.replace(/\r\n?/g, "\n").trimEnd()}\n` }];
  const task_status: Record<string, unknown> = {};
  for (const row of plan.roadmap) task_status[row.row_key] = { milestone: "M1", planned_prs: PLANNED_PRS[row.size], prs: [], status: "not-started", title: row.title, summary: row.summary, size: row.size, depends_on: row.depends_on };
  files.push({ path: ".autonomous-team/roadmap.json", content: pretty({ milestones: { M1: { definition: `The approved plan, version ${plan.version}.`, tasks: plan.roadmap.map((row) => row.row_key) } }, task_status }) });
  const width = Math.max(2, String(plan.roadmap.length).length);
  plan.roadmap.forEach((row, i) => {
    const context = [row.summary, `Size: ${row.size}.${row.depends_on.length === 0 ? "" : ` Depends on: ${row.depends_on.join(", ")}.`}`].filter((part) => part !== "").join("\n\n");
    const sections = headings.map((heading) => `## ${heading}\n\n${heading === "Context" ? context : "_To be written when this epic starts._"}\n`);
    files.push({ path: `epics/${String(i + 1).padStart(width, "0")}-${row.row_key}.md`, content: [`# Epic ${i + 1}: ${row.title}\n`, ...sections].join("\n") });
  });
  return files;
}

/** The repo name as a coldstart project name: lower case, each run outside `[a-z0-9-]` one `-`, at most 39 characters, no hyphen at either end, `project` when nothing is left. */
export function projectNameOf(repoName: string): string {
  const name = repoName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 39).replace(/^-+|-+$/g, "");
  return name === "" ? "project" : name;
}

/** The first line of the PRD that is not blank, a heading or inside a code fence, as plain text (list and quote marks, emphasis and code marks and control characters removed), at most 200 characters. */
export function describeFrom(prd: string): string | undefined {
  let fence = false;
  for (const line of prd.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence || /^\s*(```|~~~)/.test(line) || /^\s*(#|$)/.test(line)) continue;
    const plain = line.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/^\s*(?:[>*+-]\s+|\d+[.)]\s+)*/, "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
    if (plain !== "") return Array.from(plain).slice(0, 200).join("");
  }
  return undefined;
}

export interface HostAnswers {
  /** `--name`. */
  name: string;
  /** `--language` when the host decides it (a new project); an existing one is told by the guest's own scan. */
  language?: "polyglot";
  /** Topic to question to value, for the answers file. */
  answers: Record<string, Record<string, string | number>>;
}

export function hostAnswers(plan: PlanFile): HostAnswers {
  const { setup } = plan;
  const name = projectNameOf(setup.repo_name);
  const description = describeFrom(plan.prd_md);
  const answers: HostAnswers["answers"] = {
    identity: { project_name: name, ...(description === undefined ? {} : { project_description: description }), repo_owner: setup.repo_owner, boss_github_username: setup.boss_github_username },
    deploy: { deploy_target: "none" },
    autonomy: { agent_spawn_level: 3, merge_fast_path_level: 2, external_system_level: 1, intent_generate_level: 1, human_approval_before_merge: "no", security_review_required: "yes" },
    mission: { product_vision: `See docs/PRD.md (approved plan v${plan.version}).` },
  };
  if (setup.kind === "new") answers["stack"] = { primary_language: "other", runtime_framework: "none", package_manager: "other", test_framework: "unknown", has_frontend: "no" };
  return { name, ...(setup.kind === "new" ? { language: "polyglot" as const } : {}), answers };
}
