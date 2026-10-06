import {
  ATTESTABLE_KINDS,
  gateSite,
  type Blocker,
  type Claim,
  type ClaimVerdictType,
  type SiteContent,
} from "../../../sitekit-claims/src/index.js";
import type { PublishGateReport } from "../report.js";
import type { ApprovalDb } from "./types.js";

interface ClaimRow {
  id: string;
  claim_key: string;
  locale: string;
  kind: Claim["kind"];
  verdict: ClaimVerdictType;
  evidence: unknown;
  checked_sha: string | null;
}

/** One version, with its claims resolved from the database rather than from what content embeds. */
export interface LoadedVersion {
  versionId: string;
  repoSha: string;
  approved: boolean;
  /** content with every claim's verdict, kind, evidence, checked_sha and attestation taken from claims/attestations rows. */
  content: SiteContent;
  claims: Claim[];
  rows: Map<string, ClaimRow>;
  /** ids of attestable claims with no attestation bound to this version. */
  unattested: Set<string>;
  storedReport: unknown;
}

const ATTESTABLE = new Set<string>(ATTESTABLE_KINDS);

/**
 * Loads a version inside the caller's account (null when absent or another
 * account's). The database, not the embedded content, decides each claim's
 * verdict: a claim with no row is PENDING, and a stored ATTESTED verdict
 * counts only when an attestation row is bound to THIS version.
 */
export async function loadVersion(db: ApprovalDb, accountId: string, versionId: string, lock = false): Promise<LoadedVersion | null> {
  const v = await db.query<{ site_id: string; repo_sha: string; content: unknown; report: unknown; approved_by: string | null; approved_at: unknown }>(
    `SELECT site_id, repo_sha, content, report, approved_by, approved_at FROM site_versions WHERE id = $1 AND account_id = $2${lock ? " FOR UPDATE" : ""}`,
    [versionId, accountId],
  );
  const ver = v.rows[0];
  if (!ver) return null;
  const rows = new Map<string, ClaimRow>();
  const claimRows = await db.query<ClaimRow>(
    "SELECT id, claim_key, locale, kind, verdict, evidence, checked_sha FROM claims WHERE account_id = $1 AND site_id = $2",
    [accountId, ver.site_id],
  );
  for (const r of claimRows.rows) rows.set(`${r.locale}\u0000${r.claim_key}`, r);
  const att = await db.query<{ claim_id: string; user_id: string; at: Date }>(
    "SELECT claim_id, user_id, at FROM attestations WHERE account_id = $1 AND version_id = $2",
    [accountId, versionId],
  );
  const attByClaim = new Map(att.rows.map((a) => [a.claim_id, a]));

  const raw = (ver.content ?? {}) as Record<string, unknown>;
  const embedded = Array.isArray(raw.claims) ? (raw.claims as Claim[]) : [];
  const unattested = new Set<string>();
  const claims = embedded.map((c) => {
    const row = c && typeof c === "object" ? rows.get(`${c.locale}\u0000${c.id}`) : undefined;
    if (!row) return { ...c, verdict: "PENDING" as const, evidence: [], attestation: undefined };
    const a = ATTESTABLE.has(row.kind) ? attByClaim.get(row.id) : undefined;
    if (ATTESTABLE.has(row.kind) && !a) unattested.add(c.id);
    const stored = row.verdict === "ATTESTED" ? "PENDING" : row.verdict;
    return {
      ...c,
      kind: row.kind,
      verdict: a ? ("ATTESTED" as const) : stored,
      evidence: Array.isArray(row.evidence) ? (row.evidence as Claim["evidence"]) : [],
      checked_sha: row.checked_sha ?? "",
      attestation: a ? { user_id: a.user_id, at: new Date(a.at).toISOString(), version_id: versionId } : undefined,
    };
  });
  const content = { ...raw, claims } as unknown as SiteContent;
  return { versionId, repoSha: ver.repo_sha, approved: ver.approved_by !== null || ver.approved_at !== null, content, claims, rows, unattested, storedReport: ver.report };
}

export function siteBlockers(l: LoadedVersion): Blocker[] {
  return gateSite(l.content, { repoSha: l.repoSha, versionId: l.versionId });
}

const VERDICTS = ["VERIFIED", "FALSE", "UNVERIFIABLE", "CONFLICT", "PENDING", "ATTESTED"] as const;
const SHA = /^[0-9a-f]{7,64}$/i;

/** A real calendar date in ISO 8601 (YYYY-MM-DD, optionally with a time); anything else is no date. */
function isoDate(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(v);
  if (!m || Number.isNaN(Date.parse(v))) return undefined;
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)).toISOString().slice(0, 10) === m[0].slice(0, 10) ? v : undefined;
}

export interface EvidenceLink {
  claimId: string;
  path: string;
  /** The pinned commit, never a branch name. */
  sha: string;
  /** Only when the evidence record carries one; never invented. */
  date?: string;
  /** "traced to commit X on date Y", or "traced to commit X" without a date. */
  text: string;
  href?: string;
}

export interface ReportBlocker {
  source: "gateSite" | "leak" | "links" | "gates";
  reason: string;
  claimId?: string;
  detail: string;
}

export interface VerifyReport {
  version: 1;
  versionId: string;
  counts: Record<(typeof VERDICTS)[number], number> & { total: number };
  blockers: ReportBlocker[];
  evidence: EvidenceLink[];
  /** Fails closed: true only with no blocker and a passing gate result. */
  ok: boolean;
}

export function buildReport(l: LoadedVersion, gates: PublishGateReport | null): VerifyReport {
  const counts = { total: l.claims.length } as VerifyReport["counts"];
  for (const v of VERDICTS) counts[v] = l.claims.filter((c) => c.verdict === v).length;

  const blockers: ReportBlocker[] = siteBlockers(l).map((b) => ({ source: "gateSite", reason: b.reason, claimId: b.claimId, detail: b.detail }));
  if (!gates) {
    blockers.push({ source: "gates", reason: "gates-not-run", detail: "the publish gates have no result for this version" });
  } else {
    for (const f of gates.leak.findings) blockers.push({ source: "leak", reason: f.kind, detail: `${f.path}: ${f.message}` });
    for (const f of gates.links.findings) blockers.push({ source: "links", reason: f.kind, detail: `${f.path}: ${f.message}` });
    if (!gates.ok && blockers.every((b) => b.source === "gateSite")) {
      blockers.push({ source: "gates", reason: "gates-failed", detail: "the publish gates did not pass" });
    }
  }

  const repo = typeof (l.content as { repo?: unknown }).repo === "string" ? (l.content as { repo: string }).repo : "";
  const evidence: EvidenceLink[] = [];
  for (const c of l.claims) {
    for (const ev of c.evidence as Array<Record<string, unknown>>) {
      const sha = typeof ev.repo_sha === "string" ? ev.repo_sha : c.checked_sha;
      if (typeof sha !== "string" || !SHA.test(sha) || typeof ev.path !== "string") continue;
      const date = isoDate(ev.checked_at);
      const href = /^[\w.-]+\/[\w.-]+$/.test(repo)
        ? `https://github.com/${repo}/blob/${sha}/${ev.path.split("/").map(encodeURIComponent).join("/")}`
        : undefined;
      evidence.push({ claimId: c.id, path: ev.path, sha, date, text: date ? `traced to commit ${sha} on ${date}` : `traced to commit ${sha}`, href });
    }
  }
  return { version: 1, versionId: l.versionId, counts, blockers, evidence, ok: blockers.length === 0 && gates !== null && gates.ok };
}

function storedGates(report: unknown): PublishGateReport | null {
  const g = (report as { publishGates?: PublishGateReport } | null)?.publishGates;
  return g && typeof g.ok === "boolean" && Array.isArray(g.leak?.findings) && Array.isArray(g.links?.findings) ? g : null;
}

/**
 * The single read model behind the review view (D#3 C8 section 2): counts by
 * verdict, every blocker, and evidence links, built from claims rows plus
 * gateSite plus the gate result the last approve attempt persisted. Display
 * only: approve() never reads the stored gate result, it re-runs the gates.
 * With no verifier writing verdicts yet, every claim is unverified and this
 * reports ok: false.
 */
export async function buildVerifyReport(db: ApprovalDb, accountId: string, versionId: string): Promise<VerifyReport | null> {
  const l = await loadVersion(db, accountId, versionId);
  return l ? buildReport(l, storedGates(l.storedReport)) : null;
}
