/**
 * D#483 S4-i: how a proposal's verification is read.
 *
 * Three pure pieces, shared by the routes, the verifier (S4-b) and the Inbox (S4-h):
 *   - MAX_VERIFY_ATTEMPTS: the retry cap, defined once so the verifier that counts and the read that reports cannot disagree.
 *   - inboxSection: which Inbox section a proposal belongs in. The mapping lives in one table; the SQL filter on the list
 *     route is generated from the same table, so the field and the filter cannot drift apart.
 *   - buildEvidenceUrl: the link behind one piece of evidence. It is built from the repository row's owner and name plus a
 *     parsed path, line range and commit; nothing stored as link text is ever echoed.
 *
 * The module returns codes and fields only. Wording is the Inbox's.
 */

/** Consecutive failed checks after which the verifier stops retrying (the 0839 counter). */
export const MAX_VERIFY_ATTEMPTS = 3;

export const VERIFICATIONS = ['pending', 'verified', 'partly_verified', 'refuted', 'not_checked', 'check_failed'] as const;
export type Verification = (typeof VERIFICATIONS)[number];

export const INBOX_SECTIONS = ['new', 'being_checked', 'couldnt_confirm', 'not_checked'] as const;
export type InboxSection = (typeof INBOX_SECTIONS)[number];

/** The one rule. `check_failed` is "Couldn't confirm", never "Being checked": a spent retry would otherwise park it there forever. */
export const SECTION_BY_VERIFICATION: Readonly<Record<Verification, InboxSection>> = {
  verified: 'new',
  partly_verified: 'new',
  pending: 'being_checked',
  refuted: 'couldnt_confirm',
  check_failed: 'couldnt_confirm',
  not_checked: 'not_checked',
};

/** The section of a proposal, or null for anything that is not a new, product-owned proposal. */
export function inboxSection(p: { state: string; owner_process: string; verification: Verification }): InboxSection | null {
  if (p.state !== 'new' || p.owner_process !== 'product') return null;
  return SECTION_BY_VERIFICATION[p.verification] ?? null;
}

/** True only when the check failed and the verifier will try again. */
export function verifyRetry(p: { verification: Verification; verify_attempts: number }): boolean {
  return p.verification === 'check_failed' && p.verify_attempts < MAX_VERIFY_ATTEMPTS;
}

/** The members of a section, as the SQL filter on `p.verification` (built from the constant table above; no input reaches it). */
export function verificationsInSection(section: InboxSection): Verification[] {
  return VERIFICATIONS.filter((v) => SECTION_BY_VERIFICATION[v] === section);
}

export type EvidenceKind = 'file_lines' | 'issue' | 'discussion' | 'doc_passage' | 'interview_answer' | 'preview';

const OWNER_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const NUMBER_RE = /^#([1-9][0-9]{0,8})$/;
const FILE_REF_RE = /^(.+):([1-9][0-9]{0,6})(?:-([1-9][0-9]{0,6}))?$/;

/** Parses `<path>:<start>-<end>` or `<path>:<line>`. A path must be relative, have no empty, `.` or `..` segment and no backslash. */
export function parseFileRef(ref: string): { path: string; start: number; end: number } | null {
  const m = FILE_REF_RE.exec(ref);
  if (!m) return null;
  const path = m[1]!;
  if (path.includes('\\') || path.startsWith('/')) return null;
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return null;
  }
  const start = Number(m[2]);
  const end = m[3] === undefined ? start : Number(m[3]);
  if (end < start) return null;
  return { path, start, end };
}

/**
 * The GitHub link for one evidence row, or null when it cannot be built safely. `repo` comes from the repository row, never
 * from the evidence; it is re-checked here because those columns are nullable and a bad value must give no link, not a wrong one.
 * Every path segment is percent-encoded, so a `?`, `#`, `%` or space in a stored path cannot change the URL's meaning.
 */
export function buildEvidenceUrl(
  e: { kind: EvidenceKind; ref: string; commit_sha: string | null },
  repo: { owner: string | null; name: string | null },
): string | null {
  if (!repo.owner || !repo.name || !OWNER_RE.test(repo.owner) || !NAME_RE.test(repo.name)) return null;
  if (repo.name === '.' || repo.name === '..') return null;
  const base = `https://github.com/${repo.owner}/${repo.name}`;
  switch (e.kind) {
    case 'file_lines':
    case 'doc_passage': {
      if (!e.commit_sha || !SHA_RE.test(e.commit_sha)) return null;
      const f = parseFileRef(e.ref);
      if (!f) return null;
      const path = f.path.split('/').map(encodeURIComponent).join('/');
      const lines = f.start === f.end ? `#L${f.start}` : `#L${f.start}-L${f.end}`;
      return `${base}/blob/${e.commit_sha}/${path}${lines}`;
    }
    case 'issue':
    case 'discussion': {
      const m = NUMBER_RE.exec(e.ref);
      if (!m) return null;
      return `${base}/${e.kind === 'issue' ? 'issues' : 'discussions'}/${m[1]}`;
    }
    default:
      return null;
  }
}
