import type { GateResult } from "./types.js";
import { run as scanLeaks, type LeakOptions } from "./leak/scan.js";
import { run as checkLinks, type LinkPolicyOptions } from "./links/links.js";

export interface PublishGateReport {
  version: 1;
  /** true only when both gates pass; publish is blocked otherwise. */
  ok: boolean;
  leak: GateResult;
  links: GateResult;
  /** Distinct outbound URLs still awaiting approval, for the review page. */
  pendingLinks: string[];
}

export async function runPublishGates(
  renderedDir: string,
  options: LeakOptions & LinkPolicyOptions = {},
): Promise<PublishGateReport> {
  const [leak, links] = await Promise.all([scanLeaks(renderedDir, options), checkLinks(renderedDir, options)]);
  const pendingLinks = [
    ...new Set(links.findings.flatMap((f) => (f.kind === "unapproved_outbound_link" && f.subject ? [f.subject] : []))),
  ].sort();
  return { version: 1, ok: leak.ok && links.ok, leak, links, pendingLinks };
}

/** The slice of a pg-style client persistGateReport needs. */
export interface Queryable {
  query(text: string, values: unknown[]): Promise<{ rowCount: number | null }>;
}

/**
 * K06 criterion 3: store the gate result on site_versions.report (the column
 * app_user may UPDATE, 0100_sitekit.sql:274) under its own key, leaving any
 * verify-report keys K05 wrote in place. Runs under the caller's tenant
 * session, so RLS scopes it to the caller's account.
 */
export async function persistGateReport(db: Queryable, siteVersionId: string, report: PublishGateReport): Promise<void> {
  const res = await db.query(
    "UPDATE site_versions SET report = COALESCE(report, '{}'::jsonb) || jsonb_build_object('publishGates', $2::jsonb) WHERE id = $1",
    [siteVersionId, JSON.stringify(report)],
  );
  if (res.rowCount !== 1) throw new Error(`site_versions ${siteVersionId} not found or not writable`);
}
