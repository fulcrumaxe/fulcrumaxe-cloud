import {
  checkA11y,
  checkA11yStructure,
  checkDegrade,
  checkFreshness,
  checkLinks,
  checkMeta,
  checkMotion,
  checkNojs,
  checkRedaction,
  checkRender,
  checkWeight,
  type BrowserDriver,
  type CheckResult,
  type EvidenceCommits,
} from "@fx/sitekit-checks";
import type { Queryable } from "../report.js";
import type { Finding } from "../types.js";

/**
 * The checks approve() runs, pinned by a test. Not run: check-headers (K08 checks it at publish, when the deploy headers
 * exist), check-i18n-catalogue / check-i18n-chrome (English-only template; whoever adds locales adds both), check-search.
 */
export const STATIC_CHECKS = ["check-links", "check-meta", "check-nojs", "check-weight", "check-redaction", "check-a11y", "check-freshness"] as const;
export const BROWSER_CHECKS = ["check-render", "check-a11y-structure", "check-motion", "check-degrade"] as const;

export interface ApprovalChecksReport {
  version: 1;
  ok: boolean;
  checks: { check: string; ok: boolean; findings: Finding[] }[];
}

/** `now` is the approval clock. The server has no `driver` until K12c, so the browser checks then fail closed. */
export interface ApprovalCheckInput {
  siteDomains: string[];
  now: Date;
  driver?: BrowserDriver;
  /** The commit ids check-redaction may let through in evidence links. Built from the loaded version, never from a request. */
  evidenceCommits?: EvidenceCommits;
}

/** The exemption check-redaction is given: the version's own repo, its repo_sha and each claim's checked_sha. check-redaction itself keeps only 40 or 64 lowercase hex. */
export function evidenceCommitsOf(content: { repo?: unknown }, repoSha: string, claims: { checked_sha?: string | null }[]): EvidenceCommits {
  const shas = [repoSha, ...claims.map((c) => c.checked_sha ?? "")].filter((s) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s));
  return { host: "github.com", repo: typeof content.repo === "string" ? content.repo : "", shas };
}

/** Runs both lists on the directory approve() just rendered. A check fails when its ok is false (advisory findings never fail it) or it throws. */
export async function runApprovalChecks(dir: string, input: ApprovalCheckInput): Promise<ApprovalChecksReport> {
  const browser = { driver: input.driver };
  const runs: Record<(typeof STATIC_CHECKS)[number] | (typeof BROWSER_CHECKS)[number], () => Promise<CheckResult>> = {
    "check-links": () => checkLinks(dir, { live: false, siteDomains: input.siteDomains }),
    "check-meta": () => checkMeta(dir),
    "check-nojs": () => checkNojs(dir),
    "check-weight": () => checkWeight(dir),
    "check-redaction": () => checkRedaction(dir, input.evidenceCommits ? { evidenceCommits: input.evidenceCommits } : undefined),
    "check-a11y": () => checkA11y(dir),
    "check-freshness": () => checkFreshness(dir, { now: input.now }),
    "check-render": () => checkRender(dir, browser),
    "check-a11y-structure": () => checkA11yStructure(dir, browser),
    "check-motion": () => checkMotion(dir, browser),
    "check-degrade": () => checkDegrade(dir, browser),
  };
  const checks: ApprovalChecksReport["checks"] = [];
  for (const check of [...STATIC_CHECKS, ...BROWSER_CHECKS]) {
    try {
      const r = await runs[check]();
      checks.push({ check, ok: r.ok === true, findings: r.findings });
    } catch {
      checks.push({ check, ok: false, findings: [{ path: "/", kind: "check_error", message: "the check could not run", severity: "error" }] });
    }
  }
  return { version: 1, ok: checks.every((c) => c.ok), checks };
}

/** Stores the result under its own key, next to publishGates and K05's keys. Runs before any refusal is returned. */
export async function persistApprovalChecks(db: Queryable, siteVersionId: string, report: ApprovalChecksReport): Promise<void> {
  const res = await db.query(
    "UPDATE site_versions SET report = COALESCE(report, '{}'::jsonb) || jsonb_build_object('approvalChecks', $2::jsonb) WHERE id = $1",
    [siteVersionId, JSON.stringify(report)],
  );
  if (res.rowCount !== 1) throw new Error(`site_versions ${siteVersionId} not found or not writable`);
}
