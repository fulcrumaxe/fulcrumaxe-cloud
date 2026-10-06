/**
 * The run report (T2a): `results.json`, the job-summary table and the issue-title format. Pure apart from
 * `writeReport`, which is the only place this module touches disk, and which scrubs first: every string is
 * redacted, the serialised text is checked once more, and if anything is still there nothing is written.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plan } from "./plan.js";
import { assertClean, redactDeep, type ScrubContext } from "./scrub.js";

export const OUTCOMES = ["PASS", "FAIL", "FLAKY", "SKIPPED-NEED", "REFUSED", "RESERVED", "ABORTED-BUDGET"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export type TestStatus = "passed" | "failed" | "flaky" | "skipped";

export interface TestResult {
  title: string;
  device: string;
  status: TestStatus;
  duration_ms: number;
  /** A failure message. Free text, so it is redacted on the way out like everything else. */
  error?: string;
}

export interface PackResult {
  id: string;
  outcome: Outcome;
  duration_ms: number;
  devices: string[];
  /** Measured, not estimated. */
  cost_usd: number;
  /** For SKIPPED-NEED. */
  need?: string;
  /** For REFUSED. */
  reason?: string;
  tests?: TestResult[];
}

export interface Results {
  version: 1;
  target: string;
  trigger: string | null;
  commit: string | null;
  started_at: string;
  finished_at: string;
  packs: PackResult[];
  counts: Record<Outcome, number>;
  total_cost_usd: number;
  /** Files put in the upload set without being scanned (`--include-unscanned`, a debugging run). Empty normally. */
  included_unscanned: string[];
}

export interface ResultsInput {
  target: string;
  trigger?: string | null;
  commit?: string | null;
  started_at: string;
  finished_at: string;
  packs: PackResult[];
  included_unscanned?: string[];
}

export function buildResults(input: ResultsInput): Results {
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
  for (const p of input.packs) counts[p.outcome] += 1;
  const sorted = [...input.packs].sort((a, b) => a.id.localeCompare(b.id));
  return {
    version: 1,
    target: input.target,
    trigger: input.trigger ?? null,
    commit: input.commit ?? null,
    started_at: input.started_at,
    finished_at: input.finished_at,
    packs: sorted,
    counts,
    // Rounded so float noise (0.1 + 0.2) does not reach the report.
    included_unscanned: [...(input.included_unscanned ?? [])],
    total_cost_usd: Math.round(input.packs.reduce((sum, p) => sum + p.cost_usd, 0) * 1e6) / 1e6,
  };
}

/** The plan's packs that will not run, as results: a skip or a refusal is reported, never dropped. */
export function notRunFromPlan(plan: Plan): PackResult[] {
  const out: PackResult[] = [];
  for (const s of plan.skipped) out.push({ id: s.id, outcome: "SKIPPED-NEED", need: s.need, duration_ms: 0, devices: [], cost_usd: 0 });
  for (const r of plan.refused) out.push({ id: r.id, outcome: "REFUSED", reason: r.reason, duration_ms: 0, devices: [], cost_usd: 0 });
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Summary table

function cell(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function outcomeText(p: PackResult): string {
  if (p.outcome === "SKIPPED-NEED" && p.need !== undefined) return `SKIPPED-NEED ${p.need}`;
  if (p.outcome === "REFUSED" && p.reason !== undefined) return `REFUSED ${p.reason}`;
  return p.outcome;
}

/** The job-summary table, one row per pack: outcome, duration, devices, measured cost. GitHub-flavoured Markdown. */
export function summaryTable(results: Results, redactions = 0): string {
  const lines = [
    `### Live end-to-end: ${cell(results.target)}`,
    "",
    "| Pack | Outcome | Duration | Devices | Cost |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const p of results.packs) {
    lines.push(
      `| ${cell(p.id)} | ${cell(outcomeText(p))} | ${formatDuration(p.duration_ms)} | ${cell(p.devices.length > 0 ? p.devices.join(", ") : "-")} | ${formatCost(p.cost_usd)} |`,
    );
  }
  const counted = OUTCOMES.filter((o) => results.counts[o] > 0).map((o) => `${results.counts[o]} ${o}`);
  if (results.included_unscanned.length > 0) {
    lines.push("", `Debugging run: ${results.included_unscanned.length} file(s) were uploaded WITHOUT being scanned: ${results.included_unscanned.map(cell).join(", ")}.`);
  }
  lines.push("", `${counted.length > 0 ? counted.join(", ") : "no packs"}. Total measured cost ${formatCost(results.total_cost_usd)}.`, `Redacted before writing: ${redactions} value(s).`, "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------------
// Issue title

const ISSUE_PART = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const ISSUE_LABEL = "live-e2e";

/**
 * One issue per failing pack and target: `live-e2e: <pack> on <target>`. Both parts must be plain pack/target
 * ids (lower-case letters, digits, hyphen), so the title can never carry free text, and the same pack and target
 * always give the same title, which is how the next run finds the issue to update or close.
 */
export function issueTitle(pack: string, target: string): string {
  // The rejected input is never echoed: it may be anything, including a secret.
  if (!ISSUE_PART.test(pack)) throw new Error("issue title: the pack is not a plain pack id");
  if (!ISSUE_PART.test(target)) throw new Error("issue title: the target is not a plain target name");
  return `${ISSUE_LABEL}: ${pack} on ${target}`;
}

// ---------------------------------------------------------------------------------------------------------
// Writing

/** Redacts, re-checks and only then returns the text to write. Throws `ScrubError` if a secret survives. */
export function scrubbedJson(value: unknown, ctx: ScrubContext): string {
  const text = `${JSON.stringify(redactDeep(value, ctx), null, 2)}\n`;
  assertClean(text, ctx);
  return text;
}

export function scrubbedText(text: string, ctx: ScrubContext): string {
  const out = redactDeep(text, ctx);
  assertClean(out, ctx);
  return out;
}

/**
 * Writes `results.json` and `summary.md` into `dir`, scrubbed before they touch the disk. The summary says how
 * many values were redacted, and the count is returned too: a test that puts a secret in an error message
 * should not pass unnoticed.
 */
export function writeReport(
  dir: string,
  results: Results,
  ctx: ScrubContext,
): { resultsPath: string; summaryPath: string; redactions: number } {
  const stats = { redactions: 0 };
  const counted: ScrubContext = { ...ctx, stats };
  // Compute both texts first: if either refuses, neither file is written.
  const json = scrubbedJson(results, counted);
  const redactionsInResults = stats.redactions;
  const md = scrubbedText(summaryTable(results, redactionsInResults), counted);
  const resultsPath = join(dir, "results.json");
  const summaryPath = join(dir, "summary.md");
  mkdirSync(dirname(resultsPath), { recursive: true });
  writeFileSync(resultsPath, json);
  writeFileSync(summaryPath, md);
  return { resultsPath, summaryPath, redactions: stats.redactions };
}

/** Writes any text artifact (a log, the request log) scrubbed first. Returns how many values it redacted. */
export function writeScrubbed(path: string, text: string, ctx: ScrubContext): number {
  const stats = { redactions: 0 };
  const clean = scrubbedText(text, { ...ctx, stats });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, clean);
  return stats.redactions;
}
