#!/usr/bin/env node
// Compares two versions of .github/workflows/ci.yml and says whether they differ ONLY inside the two scope steps
// that the merge-queue scoping is allowed to touch, and only in the lines it is allowed to touch.
//
//   node scripts/ci/compare-ci-workflow.mjs <before> <after>      exit 0 = only the allowed lines changed
//
// The two steps are `CI scope` (job `check`) and `E2E scope (${{ matrix.project }})` (job `workspace-e2e`). Each is
// cut out of both files; everything left (every trigger, permission, concurrency, secret, runs-on, timeout, and
// every other step, comments included) must be byte-identical. Inside the cut blocks:
//   CI scope           may change its `if:`, the CI_OVERLAY_LIST line, the `run:` line, and add the scope env lines
//   E2E scope          may change only the `run:` line and add the scope env lines (its `if:` and the rest stay)
// The scope env lines are CI_SCOPE_BASE, CI_SCOPE_HEAD and CI_EVENT_NAME (and the comment line above them).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const STEPS = [
  {
    job: "check",
    name: "CI scope",
    removable: [/^ {8}if: /, /^ {10}CI_OVERLAY_LIST: /, /^ {8}run: /],
    addable: [/^ {8}if: /, /^ {10}CI_OVERLAY_LIST: /, /^ {8}run: /, /^ {10}CI_SCOPE_BASE: /, /^ {10}CI_SCOPE_HEAD: /, /^ {10}CI_EVENT_NAME: /, /^ {10}# A merge queue group is the range/],
  },
  {
    job: "workspace-e2e",
    name: "E2E scope (${{ matrix.project }})",
    removable: [/^ {8}run: /],
    addable: [/^ {8}run: /, /^ {10}CI_SCOPE_BASE: /, /^ {10}CI_SCOPE_HEAD: /, /^ {10}CI_EVENT_NAME: /, /^ {10}# A merge queue group is the range/],
  },
];

const STEP_END = /^( {6}(- |#)| {0,4}\S)/;

/** Cuts the step `name` of job `job` out of `text`: { block: [lines], rest: string } or null when absent. */
function cut(text, job, name) {
  const lines = text.split("\n");
  const jobAt = lines.findIndex((l) => l === `  ${job}:`);
  if (jobAt === -1) return null;
  const from = lines.findIndex((l, i) => i > jobAt && l === `      - name: ${name}`);
  if (from === -1) return null;
  const nextJob = lines.findIndex((l, i) => i > jobAt && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
  if (nextJob !== -1 && nextJob < from) return null;
  let to = lines.length;
  for (let i = from + 1; i < lines.length; i++) {
    if (STEP_END.test(lines[i])) {
      to = i;
      break;
    }
  }
  return { block: lines.slice(from, to), rest: [...lines.slice(0, from), `<<cut ${job}/${name}>>`, ...lines.slice(to)].join("\n") };
}

/** Returns { ok, problems: [string] }. */
export function compareWorkflows(before, after) {
  const problems = [];
  let b = before;
  let a = after;
  for (const step of STEPS) {
    const cb = cut(b, step.job, step.name);
    const ca = cut(a, step.job, step.name);
    if (!cb || !ca) {
      problems.push(`step "${step.name}" of job ${step.job} is missing on one side`);
      continue;
    }
    b = cb.rest;
    a = ca.rest;
    const sb = new Set(cb.block);
    const sa = new Set(ca.block);
    for (const line of cb.block) {
      if (!sa.has(line) && !step.removable.some((re) => re.test(line))) problems.push(`${step.name}: a line outside the allowed ones was removed or changed: ${line.trim()}`);
    }
    for (const line of ca.block) {
      if (!sb.has(line) && !step.addable.some((re) => re.test(line))) problems.push(`${step.name}: a line outside the allowed ones was added or changed: ${line.trim()}`);
    }
  }
  if (b !== a) {
    const lb = b.split("\n");
    const la = a.split("\n");
    const at = lb.findIndex((l, i) => l !== la[i]);
    problems.push(`the workflow differs outside the two scope steps (first difference at line ${at + 1}: ${JSON.stringify((lb[at] ?? "").trim())} -> ${JSON.stringify((la[at] ?? "").trim())})`);
  }
  return { ok: problems.length === 0, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [beforeFile, afterFile] = process.argv.slice(2);
  if (!beforeFile || !afterFile) {
    console.error("usage: compare-ci-workflow.mjs <before> <after>");
    process.exit(2);
  }
  const res = compareWorkflows(readFileSync(beforeFile, "utf8"), readFileSync(afterFile, "utf8"));
  if (res.ok) console.log("ok: only the allowed lines of the two scope steps differ");
  else for (const p of res.problems) console.error(p);
  process.exit(res.ok ? 0 : 1);
}
