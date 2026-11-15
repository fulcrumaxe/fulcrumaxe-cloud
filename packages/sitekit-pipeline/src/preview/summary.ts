import type { VerifyReport } from "../verify/index.js";

export interface PreviewSummary {
  claims: number;
  unverifiable: number;
  blockers: number;
  /** "N claims, M unverifiable, K blockers" */
  line: string;
}

export function summaryLine(claims: number, unverifiable: number, blockers: number): string {
  return `${claims} claims, ${unverifiable} unverifiable, ${blockers} blockers`;
}

/** The three numbers the screen shows, from the verify pass's report. Every claim is counted once, whatever its verdict. */
export function summarize(report: Pick<VerifyReport, "counts" | "blockers">): PreviewSummary {
  const claims = Object.values(report.counts).reduce((n, c) => n + c, 0);
  const unverifiable = report.counts.UNVERIFIABLE;
  const blockers = report.blockers.length;
  return { claims, unverifiable, blockers, line: summaryLine(claims, unverifiable, blockers) };
}
