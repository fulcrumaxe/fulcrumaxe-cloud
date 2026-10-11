import type { Pool, PoolClient } from 'pg';
import { redactShapes } from '@fx/runtime/src/redact.js';
import { stripControlTokens } from '@fx/trust';
import { ForbiddenError, NotFoundError } from '../tenancy/errors.js';
import { assertActiveMembership } from '../tenancy/scopedAccess.js';
import { withTenant } from '../tenancy/withTenant.js';

/**
 * D#601 MEM-1: the durable memory store. Values mirror the CHECKs of migration 0793. Every write goes through a database function that
 * re-derives the caller's rights; this module cleans the text first, maps the database's refusals onto the errors a route already
 * answers, and reads back. Trust follows who wrote the bytes: `authorKind` is fixed at proposal time and no call here changes it.
 */
export const MEMORY_SCOPES = ['account', 'repo', 'item', 'role'] as const;
export const MEMORY_KINDS = ['convention', 'command', 'fact', 'gotcha', 'preference', 'decision'] as const;
export const MEMORY_AUTHOR_KINDS = ['person', 'agent', 'assistant', 'import', 'runner_agent'] as const;
export const MEMORY_STATUSES = ['proposed', 'approved', 'rejected', 'expired', 'retired', 'deleted', 'archived', 'superseded'] as const;
/** What a person's click can set through `decideMemory`. Expiry, archiving and supersession are never set by a click. */
export const MEMORY_DECISIONS = ['approved', 'rejected', 'retired', 'proposed'] as const;

export const MEMORY_BODY_MAX_BYTES = 1024;
export const MEMORY_WHY_MAX_BYTES = 256;
export const MEMORY_ACTIVE_CAPS = { repo: 200, account: 100, role: 50, item: 30 } as const;
export const MEMORY_PENDING_MAX_PER_SCOPE = 20;
export const MEMORY_PROPOSALS_PER_RUN = 3;
export const MEMORY_PROPOSAL_EXPIRY_DAYS = 14;
export const MEMORY_RETIRE_AFTER_DAYS = 90;
export const MEMORY_DELETED_PURGE_DAYS = 30;
export const MEMORY_IMPORT_MAX_BYTES = 32 * 1024;

export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryAuthorKind = (typeof MEMORY_AUTHOR_KINDS)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
export type MemoryDecision = (typeof MEMORY_DECISIONS)[number];

/** The provenance keys the database accepts. Each records where the bytes came from, never the bytes. */
export interface MemoryProvenance {
  source_run_id?: string;
  backend?: string;
  model_id?: string;
  input_trust_classes?: unknown;
  source_commit?: string;
  file_sha?: string;
  source_path?: string;
  receipt_id?: string;
  evidence?: string;
}

export interface MemoryEntry {
  id: string;
  accountId: string;
  scope: MemoryScope;
  scopeRef: string | null;
  kind: MemoryKind;
  body: string;
  why: string | null;
  authorKind: MemoryAuthorKind;
  provenance: MemoryProvenance;
  status: MemoryStatus;
  /** Null once the user is deleted, and for a pipeline-written proposal. Render as "a former member" or the source, never as null. */
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  expiresAt: Date | null;
  version: number;
  supersedesId: string | null;
  contentSha256: string;
  createdAt: Date;
  updatedAt: Date;
}

export type MemoryErrorCode = 'invalid_message' | 'invalid_transition' | 'secret_detected' | 'memory_full' | 'conflict';

/** Maps to 422. */
export class MemoryInputError extends Error {
  constructor(
    readonly code: MemoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MemoryInputError';
  }
}

export interface MemoryCtx {
  pool: Pool;
  principal: { accountId: string; userId: string };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const FENCE_RE = /<<UNTRUSTED EXTERNAL CONTENT>>|<<END UNTRUSTED>>/g;
const COLUMNS = `id, account_id, scope, scope_ref, kind, body, why, author_kind, provenance, status, created_by, approved_by, approved_at,
  expires_at, version, supersedes_id, content_sha256, created_at, updated_at`;

interface Row {
  id: string;
  account_id: string;
  scope: MemoryScope;
  scope_ref: string | null;
  kind: MemoryKind;
  body: string;
  why: string | null;
  author_kind: MemoryAuthorKind;
  provenance: MemoryProvenance;
  status: MemoryStatus;
  created_by: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  expires_at: Date | null;
  version: number;
  supersedes_id: string | null;
  content_sha256: string;
  created_at: Date;
  updated_at: Date;
}

function toEntry(r: Row): MemoryEntry {
  return {
    id: r.id,
    accountId: r.account_id,
    scope: r.scope,
    scopeRef: r.scope_ref,
    kind: r.kind,
    body: r.body,
    why: r.why,
    authorKind: r.author_kind,
    provenance: r.provenance,
    status: r.status,
    createdBy: r.created_by,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    expiresAt: r.expires_at,
    version: r.version,
    supersedesId: r.supersedes_id,
    contentSha256: r.content_sha256,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** A repo's scope_ref: the GitHub node id and the installation id together, so a change to either is a different scope. */
export function repoScopeRef(repoNodeId: string, installationId: number | string): string {
  return `${repoNodeId}@${installationId}`;
}

/**
 * Cleans one piece of memory text before it is stored: NFKC and zero-width characters removed, control-plane tokens (a SPAWN_REQUEST, a
 * STATUS line, an HTML comment) replaced by a marker, control characters and both fence delimiters replaced, and the ends trimmed. The
 * result is plain text. Cleaning is not trust: whether the text sits inside the fence at render time follows `authorKind`.
 */
export function sanitizeMemoryText(text: string): string {
  return stripControlTokens(text).replace(CONTROL_RE, ' ').replace(FENCE_RE, '[removed]').trim();
}

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * Cleans and checks a body and its reason. A credential-shaped value is a visible refusal (`secret_detected`), not a silent redaction,
 * so the person sees why nothing was stored. (Redaction over the tenant's live token values joins in at proposal intake.)
 */
export function prepareMemoryText(body: unknown, why?: string | null): { body: string; why: string | null } {
  if (typeof body !== 'string' || (why !== undefined && why !== null && typeof why !== 'string')) throw new MemoryInputError('invalid_message', 'memory text must be a string');
  const cleanBody = sanitizeMemoryText(body);
  const cleanWhy = why === undefined || why === null ? null : sanitizeMemoryText(why);
  if (cleanBody === '' || bytes(cleanBody) > MEMORY_BODY_MAX_BYTES) throw new MemoryInputError('invalid_message', `a memory is 1 to ${MEMORY_BODY_MAX_BYTES} bytes`);
  if (cleanWhy !== null && bytes(cleanWhy) > MEMORY_WHY_MAX_BYTES) throw new MemoryInputError('invalid_message', `a reason is at most ${MEMORY_WHY_MAX_BYTES} bytes`);
  for (const text of [cleanBody, cleanWhy ?? '']) {
    if (redactShapes(text) !== text) throw new MemoryInputError('secret_detected', 'that text looks like it holds a credential, so it was not stored');
  }
  return { body: cleanBody, why: cleanWhy === '' ? null : cleanWhy };
}

/** The database's refusals, mapped onto the errors a route already knows how to answer. */
export function mapMemoryDbError(err: unknown): unknown {
  const e = err as { code?: string; message?: string } | null;
  if (e?.code === '42501') return new ForbiddenError('not allowed to do that to a memory entry');
  if (e?.code === 'P0002' || e?.code === '23503') return new NotFoundError('memory entry or work item not found');
  if (e?.code === '54000') return new MemoryInputError('memory_full', 'that scope already holds its limit of approved entries');
  // Two concurrent edits of one entry: the second hits the one-successor index. Fixed code, no constraint name passed through.
  if (e?.code === '23505') return new MemoryInputError('conflict', 'that entry was changed by someone else; reload and try again');
  if (e?.code === '22023') {
    const m = /^(invalid_transition|invalid_message)/.exec(e.message ?? '');
    if (m !== null) return new MemoryInputError(m[1] as MemoryErrorCode, (e.message ?? '').replace(/^invalid_\w+:\s*/, ''));
  }
  // A table CHECK (23514) or any other 22023 carries a Postgres constraint or function name, so it gets a fixed message instead.
  if (e?.code === '22023' || e?.code === '23514') return new MemoryInputError('invalid_message', 'that memory entry is not valid');
  return err;
}

function assertUuid(label: string, id: string): void {
  if (!UUID_RE.test(id)) throw new NotFoundError(`${label} ${id} not found`);
}

function assertEnum<T extends string>(label: string, list: readonly T[], v: unknown): asserts v is T {
  if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) throw new MemoryInputError('invalid_message', `unknown ${label}`);
}

async function inSession<T>(ctx: MemoryCtx, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    await assertActiveMembership(client, accountId, userId);
    try {
      return await fn(client);
    } catch (err) {
      throw mapMemoryDbError(err);
    }
  });
}

async function readEntry(client: PoolClient, id: string): Promise<MemoryEntry> {
  const { rows } = await client.query<Row>(`SELECT ${COLUMNS} FROM memory_entries WHERE id = $1::uuid`, [id]);
  return toEntry(rows[0]!);
}

export interface ProposeMemoryInput {
  scope: MemoryScope;
  /** Null for `account`; otherwise a repoScopeRef, a work item id or a role name. */
  scopeRef: string | null;
  kind: MemoryKind;
  body: string;
  why?: string | null;
  /** Defaults to 'person'. An agent, assistant, import or runner body is stored as proposed and stays fenced for good. */
  authorKind?: MemoryAuthorKind;
  provenance?: MemoryProvenance;
}

/** Records an entry as `proposed`, expiring in 14 days. Any active member may. A proposal is never recalled. */
export async function proposeMemory(ctx: MemoryCtx, input: ProposeMemoryInput): Promise<MemoryEntry> {
  assertEnum('scope', MEMORY_SCOPES, input.scope);
  assertEnum('kind', MEMORY_KINDS, input.kind);
  const authorKind = input.authorKind ?? 'person';
  assertEnum('author_kind', MEMORY_AUTHOR_KINDS, authorKind);
  const text = prepareMemoryText(input.body, input.why);
  return inSession(ctx, async (client) => {
    const { rows } = await client.query<{ id: string }>('SELECT memory_propose($1, $2, $3, $4, $5, $6, $7::jsonb) AS id', [
      input.scope,
      input.scopeRef,
      input.kind,
      text.body,
      text.why,
      authorKind,
      JSON.stringify(input.provenance ?? {}),
    ]);
    return readEntry(client, rows[0]!.id);
  });
}

/** An owner or admin (any member, for item scope) writes a person-typed entry straight to `approved`. */
export async function writeMemory(ctx: MemoryCtx, input: Omit<ProposeMemoryInput, 'authorKind'>): Promise<MemoryEntry> {
  assertEnum('scope', MEMORY_SCOPES, input.scope);
  assertEnum('kind', MEMORY_KINDS, input.kind);
  const text = prepareMemoryText(input.body, input.why);
  return inSession(ctx, async (client) => {
    const { rows } = await client.query<{ id: string }>('SELECT memory_write($1, $2, $3, $4, $5, $6::jsonb) AS id', [
      input.scope,
      input.scopeRef,
      input.kind,
      text.body,
      text.why,
      JSON.stringify(input.provenance ?? {}),
    ]);
    return readEntry(client, rows[0]!.id);
  });
}

export type DecideMemoryResult = { outcome: 'decided' | 'already_decided'; entry: MemoryEntry };

/** Approve, reject, retire, or take a step back (approved to proposed, rejected to proposed, retired to approved, expired to proposed). */
export async function decideMemory(ctx: MemoryCtx, input: { id: string; to: MemoryDecision }): Promise<DecideMemoryResult> {
  assertEnum('decision', MEMORY_DECISIONS, input.to);
  assertUuid('memory entry', input.id);
  return inSession(ctx, async (client) => {
    const { rows } = await client.query<{ r: string }>('SELECT memory_decide($1::uuid, $2) AS r', [input.id, input.to]);
    return { outcome: rows[0]!.r === 'decided' ? 'decided' : 'already_decided', entry: await readEntry(client, input.id) };
  });
}

/**
 * Inserts the next version and sets the old one aside as `superseded`. The author kind is carried over unchanged, so a person editing an
 * agent's proposal does not move its bytes out of the fence. Naming `scope` moves the entry ("Change scope"); `scopeRef` then names the
 * new ref. Returns the new version.
 */
export async function editMemory(
  ctx: MemoryCtx,
  input: { id: string; body: string; why?: string | null; kind?: MemoryKind; scope?: MemoryScope; scopeRef?: string | null },
): Promise<MemoryEntry> {
  assertUuid('memory entry', input.id);
  if (input.kind !== undefined) assertEnum('kind', MEMORY_KINDS, input.kind);
  if (input.scope !== undefined) assertEnum('scope', MEMORY_SCOPES, input.scope);
  const text = prepareMemoryText(input.body, input.why);
  return inSession(ctx, async (client) => {
    const { rows } = await client.query<{ id: string }>('SELECT memory_edit($1::uuid, $2, $3, $4, $5, $6) AS id', [
      input.id,
      text.body,
      text.why,
      input.kind ?? null,
      input.scope ?? null,
      input.scope === undefined ? null : (input.scopeRef ?? null),
    ]);
    return readEntry(client, rows[0]!.id);
  });
}

/** Soft delete; `restore: true` brings it back to its prior status inside 30 days. */
export async function deleteMemory(ctx: MemoryCtx, input: { id: string; restore?: boolean }): Promise<{ outcome: string; entry: MemoryEntry }> {
  assertUuid('memory entry', input.id);
  return inSession(ctx, async (client) => {
    const { rows } = await client.query<{ r: string }>('SELECT memory_delete($1::uuid, $2) AS r', [input.id, input.restore === true]);
    return { outcome: rows[0]!.r, entry: await readEntry(client, input.id) };
  });
}

/** One entry by id, or NotFoundError (also for another account's id: RLS makes the two the same). */
export async function getMemory(ctx: MemoryCtx, id: string): Promise<MemoryEntry> {
  assertUuid('memory entry', id);
  return inSession(ctx, async (client) => {
    const { rows } = await client.query<Row>(`SELECT ${COLUMNS} FROM memory_entries WHERE id = $1::uuid`, [id]);
    if (rows[0] === undefined) throw new NotFoundError(`memory entry ${id} not found`);
    return toEntry(rows[0]);
  });
}

const COLUMNS_M = COLUMNS.split(',').map((c) => `m.${c.trim()}`).join(', ');

/** The version chain that ends at an entry (the entry and every version it replaced), oldest first, so every prior text stays readable. */
export async function listMemoryVersions(ctx: MemoryCtx, id: string): Promise<MemoryEntry[]> {
  assertUuid('memory entry', id);
  return inSession(ctx, async (client) => {
    const { rows } = await client.query<Row>(
      `WITH RECURSIVE chain AS (
         SELECT ${COLUMNS} FROM memory_entries WHERE id = $1::uuid
         UNION ALL
         SELECT ${COLUMNS_M} FROM memory_entries m JOIN chain ON m.id = chain.supersedes_id
       ) SELECT * FROM chain ORDER BY version`,
      [id],
    );
    return rows.map(toEntry);
  });
}
