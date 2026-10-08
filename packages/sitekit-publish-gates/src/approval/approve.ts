import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderSite, writeRenderedSite } from "../../../sitekit-template/src/index.js";
import type { BrowserDriver } from "@fx/sitekit-checks";
import { persistGateReport, runPublishGates, type PublishGateReport } from "../report.js";
import { requireAdmin } from "./access.js";
import { evidenceCommitsOf, persistApprovalChecks, runApprovalChecks, type ApprovalChecksReport } from "./checks.js";
import { buildReport, loadVersion, siteBlockers, type VerifyReport } from "./report.js";
import { refuse, type ApprovalDb, type Outcome, type Principal } from "./types.js";

export interface ApproveOptions {
  /** The customer accepted the terms shown next to the button. Anything but true is refused. */
  termsAccepted: boolean;
  /** Where backgroundImage assets resolve from. Defaults to an empty directory, so a site that references an asset is refused. */
  assetRoot?: string;
  /**
   * Outbound URLs the customer has approved on the review page (K06's own
   * approvedLinks input). The template links each evidence record to the
   * pinned file on GitHub, so a site with evidence has outbound links that
   * must be approved before it can be. Anything not listed is refused.
   */
  approvedLinks?: string[];
  /** The browser the four browser checks run through. The server passes none (until K12c), so they fail closed. */
  browserDriver?: BrowserDriver;
}

/**
 * Criterion 4's data half: record approved_by / approved_at, and nothing
 * else (publishing is K08's). Never trusts a client or stored report: the
 * version is loaded with its claims resolved from the database, gateSite
 * runs on that, the site is rendered on the server and the K06 leak and link
 * gates run on the rendered output. Their result is persisted on the
 * version before any gate refusal is returned, so the caller should commit
 * the transaction on a refusal too. Owner or admin of the caller's account
 * only. Each refusal is a typed value, not a throw.
 */
export async function approve(
  db: ApprovalDb,
  p: Principal,
  versionId: string,
  options: ApproveOptions,
): Promise<Outcome<{ approvedAt: Date; report: VerifyReport }>> {
  const denied = await requireAdmin(db, p);
  if (denied) return refuse(denied);
  const l = await loadVersion(db, p.accountId, versionId, true);
  if (!l) return refuse({ code: "not_found" });
  if (l.approved) return refuse({ code: "already_approved" });
  if (options.termsAccepted !== true) return refuse({ code: "terms_not_accepted" });

  const blockers = siteBlockers(l);
  // Legal, pricing and security claims need an attestation bound to this
  // version whatever their verdict: gateSite would let a VERIFIED one render.
  if (l.unattested.size > 0) return refuse({ code: "unattested_claim", claimIds: [...l.unattested].sort(), blockers });
  if (blockers.length > 0) return refuse({ code: "blocked", blockers });

  const rawDomains = (l.content as { domains?: unknown }).domains;
  const siteDomains = Array.isArray(rawDomains) ? rawDomains.filter((d): d is string => typeof d === "string") : [];
  const work = await mkdtemp(path.join(tmpdir(), "k07-approve-"));
  let gates: PublishGateReport;
  let checks: ApprovalChecksReport | undefined;
  try {
    const assetRoot = options.assetRoot ?? path.join(work, "assets-in");
    const out = path.join(work, "site");
    await writeRenderedSite(renderSite(l.content, { repoSha: l.repoSha, versionId }, assetRoot), out);
    gates = await runPublishGates(out, { approvedLinks: options.approvedLinks, siteJson: l.content, siteDomains });
    // Once the K06 gates pass, and always on this render: a stored report is never read.
    if (gates.ok) checks = await runApprovalChecks(out, { siteDomains, now: new Date(), driver: options.browserDriver, evidenceCommits: evidenceCommitsOf(l.content, l.repoSha, l.claims) });
  } catch (e) {
    // fx-swallow-ok: the failure is returned as a render_failed refusal carrying its detail
    return refuse({ code: "render_failed", detail: e instanceof Error ? e.message : String(e) });
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  await persistGateReport(db, versionId, gates);
  if (!gates.leak.ok) return refuse({ code: "leak", findings: gates.leak.findings });
  if (!gates.links.ok) return refuse({ code: "unapproved_link", links: gates.pendingLinks, findings: gates.links.findings });

  if (!checks) throw new Error("approval checks did not run");
  await persistApprovalChecks(db, versionId, checks);
  const failed = checks.checks.filter((c) => !c.ok);
  if (failed.length > 0) return refuse({ code: "check_failed", checks: failed.map((c) => ({ check: c.check, findings: c.findings })) });

  const upd = await db.query<{ approved_at: Date }>(
    `UPDATE site_versions SET approved_by = $2, approved_at = now()
      WHERE id = $1 AND account_id = $3 AND approved_by IS NULL AND approved_at IS NULL
      RETURNING approved_at`,
    [versionId, p.userId, p.accountId],
  );
  const row = upd.rows[0];
  if (!row) return refuse({ code: "already_approved" });
  return { ok: true, approvedAt: row.approved_at, report: buildReport(l, gates) };
}
