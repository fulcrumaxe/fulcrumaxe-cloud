import type { Pool } from 'pg';
import { NotFoundError } from '../tenancy/errors.js';
import { withTenant } from '../tenancy/withTenant.js';
import { lockMemoryIntake, normalizedMemoryHash, wasDeclined } from './intake.js';
import { MEMORY_IMPORT_MAX_BYTES, MEMORY_PENDING_MAX_PER_SCOPE, MemoryInputError, mapMemoryDbError, prepareMemoryText, type LiveSecretsSource } from './index.js';
import { repoScopeRefOf } from './view.js';

/**
 * D#601 MEM-5: a repository's CLAUDE.md or AGENTS.md becomes memory PROPOSALS, never memory. This module is the only place file text turns into rows, and every row
 * it writes is a `proposed` entry whose author kind is `import`: nothing recalls it until a person opens the card and approves it (the batch rules for `import` are
 * migration 0835's), and the auto-approve dial never touches an import (`MEMORY_AUTO_APPROVE_SOURCES`). It adds no intake of its own: each section goes through the
 * same text check as a proposal (`prepareMemoryText`, so a credential is a refusal), the same duplicate and pending-cap rules, the same declined look-back, and the
 * same `memory_propose` function, in a userless tenant session.
 *
 * What is proposed: the file is cut at 32 KiB (the caller is told, so the page can say so), split into sections at headings of level 1 to 3, and each section whose
 * text is not already known becomes one proposal. A section is known when the repository already holds that text approved or pending, when a person declined it, or
 * when an earlier import of the same file proposed it in any state (a proposal that expired unread is not proposed again by the next push). So a changed file
 * proposes only its new or changed sections.
 */
export const REPO_INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;
export type RepoInstructionFile = (typeof REPO_INSTRUCTION_FILES)[number];

/** A section is cut into pieces of at most this many bytes so each fits a memory body (1024 bytes) with room for the heading repeated on a continuation. */
const CHUNK_BYTES = 960;
/** How many earlier import rows of one file the "already proposed" comparison looks at. */
const SEEN_LOOKUP_MAX = 2000;

const bytesOf = (s: string): number => Buffer.byteLength(s, 'utf8');

/** The text cut to 32 KiB at a line break, and whether anything was cut. The cut never leaves half a line or half a character. */
export function capImportText(text: string): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= MEMORY_IMPORT_MAX_BYTES) return { text, truncated: false };
  const head = buf.subarray(0, MEMORY_IMPORT_MAX_BYTES).toString('utf8').replace(/�+$/, '');
  const cut = head.lastIndexOf('\n');
  return { text: cut > 0 ? head.slice(0, cut) : head, truncated: true };
}

/** A repeated heading is cut to this many bytes (with a marker), so a continuation always has room for text whatever the heading is. */
const HEADING_MAX_BYTES = 200;
/** The smallest piece size `pieces` accepts. A character is at most 4 bytes, so every cut consumes at least one character. */
const PIECE_MIN_BYTES = 16;

/** The UTF-8 length of one code point (a lone surrogate counts 3, as `Buffer.byteLength` counts it). */
const codePointBytes = (cp: number): number => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);

/** The length, in UTF-16 units, of the longest prefix of `s` that fits `limit` bytes without splitting a character or a surrogate pair. One pass, at least one character. */
function prefixWithin(s: string, limit: number): number {
  let bytes = 0;
  let n = 0;
  for (const ch of s) {
    bytes += codePointBytes(ch.codePointAt(0)!);
    if (bytes > limit && n > 0) break;
    n += ch.length;
  }
  return n;
}

/** A heading cut to HEADING_MAX_BYTES at a character boundary, with an ellipsis where text was dropped. */
function capHeading(heading: string): string {
  if (bytesOf(heading) <= HEADING_MAX_BYTES) return heading;
  return `${heading.slice(0, prefixWithin(heading, HEADING_MAX_BYTES - 3))}…`;
}

/**
 * Pieces of `text` of at most `limit` bytes, cut at line breaks where it can and at a character boundary where it cannot. A limit below PIECE_MIN_BYTES is raised to it,
 * and each cut takes at least one character, so the loop ends for any input.
 */
export function pieces(text: string, limit: number): string[] {
  const max = Math.max(limit, PIECE_MIN_BYTES);
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    let rest = line;
    while (bytesOf(rest) > max) {
      const n = Math.max(prefixWithin(rest, max), 1);
      if (cur !== '') out.push(cur);
      cur = '';
      out.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    const next = cur === '' ? rest : `${cur}\n${rest}`;
    if (bytesOf(next) > max) {
      out.push(cur);
      cur = rest;
    } else cur = next;
  }
  if (cur !== '') out.push(cur);
  return out;
}

/**
 * The sections of a markdown instruction file, in order: a new section starts at each heading of level 1 to 3 outside a code fence, and any text before the first
 * heading is a section of its own. A section with no text besides its heading is dropped. A section longer than a memory body is cut into pieces, and each piece
 * after the first starts with the heading again, so every card reads on its own.
 */
export function splitInstructionFile(text: string): string[] {
  const sections: Array<{ heading: string; lines: string[] }> = [{ heading: '', lines: [] }];
  let fence: string | null = null;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark !== undefined) {
      if (fence === null) fence = mark[0]!;
      else if (mark[0] === fence) fence = null;
    }
    if (fence === null && mark === undefined && /^#{1,3}\s+\S/.test(line)) sections.push({ heading: capHeading(line.trim()), lines: [] });
    else sections[sections.length - 1]!.lines.push(line);
  }
  const out: string[] = [];
  for (const s of sections) {
    const content = s.lines.join('\n').trim();
    if (content === '') continue;
    const whole = s.heading === '' ? content : `${s.heading}\n${content}`;
    if (bytesOf(whole) <= CHUNK_BYTES) {
      out.push(whole);
      continue;
    }
    pieces(content, CHUNK_BYTES - (s.heading === '' ? 0 : bytesOf(s.heading) + 1)).forEach((p) => out.push(s.heading === '' ? p : `${s.heading}\n${p}`));
  }
  return out;
}

export const REPO_IMPORT_REFUSALS = ['duplicate', 'already_proposed', 'previously_declined', 'secret_detected', 'invalid_message', 'pending_full'] as const;
export type RepoImportRefusal = (typeof REPO_IMPORT_REFUSALS)[number];

export interface ImportRepoFileInput {
  pool: Pool;
  accountId: string;
  repoId: string;
  path: RepoInstructionFile;
  /** The blob sha the contents API reported for the file, and the default-branch commit it was read at. Both are stored on every proposal. */
  fileSha: string;
  sourceCommit: string;
  /** The file's text as read; it is cut to 32 KiB here. */
  text: string;
  liveSecrets: LiveSecretsSource;
}

export interface ImportRepoFileResult {
  /** True when the file was longer than 32 KiB and only its first part was read. */
  truncated: boolean;
  sections: number;
  stored: Array<{ index: number; id: string }>;
  refused: Array<{ index: number; reason: RepoImportRefusal }>;
}

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Turns the file into proposals. Safe to repeat for the same file: the second call finds every section known and writes nothing. */
export async function importRepoFile(input: ImportRepoFileInput): Promise<ImportRepoFileResult> {
  if (!(REPO_INSTRUCTION_FILES as readonly string[]).includes(input.path) || !SHA_RE.test(input.fileSha) || !SHA_RE.test(input.sourceCommit)) {
    throw new MemoryInputError('invalid_message', 'an import names one of the two instruction files and full shas');
  }
  const { text, truncated } = capImportText(input.text);
  const sections = splitInstructionFile(text);
  const secrets = await input.liveSecrets();
  return withTenant(input.pool, input.accountId, async (client) => {
    const result: ImportRepoFileResult = { truncated, sections: sections.length, stored: [], refused: [] };
    if (sections.length === 0) return result;
    // One writer at a time per account, as for a run's proposals: the pending count and the comparison below must see each other's rows.
    await lockMemoryIntake(client, input.accountId);
    const repoRef = await repoScopeRefOf(client, input.repoId);
    if (repoRef === null) throw new NotFoundError('that repository has no memory key yet');
    const live = await client.query<{ body: string; status: string }>(
      `SELECT body, status FROM memory_entries WHERE account_id = $1 AND scope = 'repo' AND scope_ref = $2 AND (status = 'approved' OR (status = 'proposed' AND expires_at > now()))`,
      [input.accountId, repoRef],
    );
    const known = new Set(live.rows.map((r) => normalizedMemoryHash(r.body)));
    const seen = await client.query<{ body: string }>(
      `SELECT body FROM memory_entries WHERE account_id = $1 AND scope = 'repo' AND scope_ref = $2 AND author_kind = 'import' AND provenance ->> 'source_path' = $3
        ORDER BY created_at DESC LIMIT $4`,
      [input.accountId, repoRef, input.path, SEEN_LOOKUP_MAX],
    );
    const proposedBefore = new Set(seen.rows.map((r) => normalizedMemoryHash(r.body)));
    let pending = live.rows.filter((r) => r.status === 'proposed').length;
    const provenance = JSON.stringify({ source_path: input.path, source_commit: input.sourceCommit, file_sha: input.fileSha, input_trust_classes: ['untrusted'] });
    for (const [index, section] of sections.entries()) {
      let body: string;
      try {
        body = prepareMemoryText(section, null, secrets).body;
      } catch (err) {
        if (err instanceof MemoryInputError) {
          result.refused.push({ index, reason: err.code === 'secret_detected' ? 'secret_detected' : 'invalid_message' });
          continue;
        }
        throw err;
      }
      const hash = normalizedMemoryHash(body);
      if (known.has(hash)) result.refused.push({ index, reason: 'duplicate' });
      else if (proposedBefore.has(hash)) result.refused.push({ index, reason: 'already_proposed' });
      else if (await wasDeclined(client, repoRef, input.repoId, null, hash)) result.refused.push({ index, reason: 'previously_declined' });
      else if (pending >= MEMORY_PENDING_MAX_PER_SCOPE) result.refused.push({ index, reason: 'pending_full' });
      else {
        await client.query('SAVEPOINT memory_import_one');
        try {
          const res = await client.query<{ id: string }>(`SELECT memory_propose('repo', $1, 'convention', $2, $3, 'import', $4::jsonb) AS id`, [repoRef, body, `From ${input.path}`, provenance]);
          await client.query('RELEASE SAVEPOINT memory_import_one');
          result.stored.push({ index, id: res.rows[0]!.id });
          known.add(hash);
          pending += 1;
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT memory_import_one');
          const mapped = mapMemoryDbError(err);
          if (!(mapped instanceof MemoryInputError)) throw err;
          result.refused.push({ index, reason: 'invalid_message' });
        }
      }
    }
    return result;
  });
}
