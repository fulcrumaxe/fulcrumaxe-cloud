import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { sanitize, stripControlTokens, structuralValue } from '@fx/trust';
import { checkBody } from '../corrections/body.js';
import { CORRECTION_BODY_MAX, CORRECTION_KINDS, CorrectionInputError, createCorrection, listCorrections } from '../corrections/index.js';
import { NotFoundError } from '../tenancy/errors.js';
import { getWorkItemActivity } from '../work-items/activity.js';
import { getWorkItem } from '../work-items/read.js';
import { VERDICT_ROLES } from '../work-items/verdictRoles.js';
import { getPlanView } from '../plan/read.js';

/**
 * D#597 CC-5d: the assistant's closed tool registry. R-597-1: the assistant answers and proposes; only a person's click acts.
 * Every tool reads in-process through the existing @fx/core reads (no HTTP) under the caller's own principal, and a read of
 * another repo's item answers "not found". `draft_correction` is the only write: it creates a `proposed` correction with
 * origin `agent` (the panel labels it from the row), created_by the caller, from model text with its control tokens defanged. Repo, issue and GitHub text in
 * a result is sanitised (D#1588: defanged and fenced as data). Inert until the route (CC-5e) imports it.
 */

export interface AssistantToolCtx {
  pool: Pool;
  principal: { accountId: string; userId: string; role?: string };
  /** The repo the conversation is about: an item of any other repo answers "not found". */
  repoId: string;
  /** The item kinds a `new_item` correction may name (the route passes DISCUSSION_KINDS, as it does to accept). */
  itemKinds: readonly string[];
}

/** Per-turn state: the drafts already written this turn, by hash, so a repeated call writes nothing. */
export interface AssistantTurnState {
  drafts: Map<string, string>;
}
export function newTurnState(): AssistantTurnState {
  return { drafts: new Map() };
}

/** Same shape as @fx/model-call's StreamToolDef (this package does not depend on it). */
export interface AssistantToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
export interface AssistantToolResult {
  text: string;
  isError: boolean;
}

/** Characters in one result and in one free-text field. */
export const TOOL_RESULT_MAX = 12_000;
export const TOOL_FIELD_MAX = 3_000;
export const TOOL_NONE = '(none)';
const NOT_FOUND = 'not found';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Field = { type: 'uuid' } | { type: 'text'; max: number } | { type: 'enum'; values: readonly string[] };
interface Tool {
  name: string;
  description: string;
  fields: Record<string, Field>;
  required: readonly string[];
  run(ctx: AssistantToolCtx, st: AssistantTurnState, input: Record<string, string>): Promise<string[]>;
}

/** Fixed word for an empty value, so a result never shows a bare null or undefined. */
function w(v: unknown): string {
  if (v === null || v === undefined) return TOOL_NONE;
  const s = String(v);
  return s.trim() === '' ? TOOL_NONE : s;
}
/**
 * A code-like field (a stage, a role, a status, a state, a result): raw only when a plain identifier, else fenced as data (the shared key rule in
 * `@fx/trust`). Every field that is not a number, a date or an id goes through `ident` or `data`; a test fails on any other use of `w`.
 */
function ident(v: unknown): string {
  const s = w(v);
  return s === TOOL_NONE ? s : structuralValue(s);
}
/** Free text from the repo, an issue, GitHub or a model: capped, then defanged and fenced as data. */
function data(v: unknown): string {
  const s = w(v);
  if (s === TOOL_NONE) return s;
  return sanitize(Array.from(s).slice(0, TOOL_FIELD_MAX).join(''));
}

async function loadItem(ctx: AssistantToolCtx, id: string) {
  const item = await getWorkItem(ctx, id);
  if (item.repo_id !== ctx.repoId) throw new NotFoundError(`work item ${id} not found`);
  return item;
}

const ITEM_ID: Record<string, Field> = { item_id: { type: 'uuid' } };

const TOOLS: readonly Tool[] = [
  {
    name: 'get_item',
    description: 'The work item: its title, stage, kind, issue number, priority and cost so far.',
    fields: ITEM_ID,
    required: ['item_id'],
    async run(ctx, _st, i) {
      const it = await loadItem(ctx, i.item_id!);
      return [
        `id: ${it.id}`, `title: ${data(it.title)}`, `stage: ${ident(it.stage)}`, `kind: ${ident(it.kind)}`, `issue_number: ${w(it.issue_number)}`,
        `provenance: ${ident(it.provenance)}`, `priority: ${ident(it.priority)}`, `cost_usd: ${w(it.cost_usd)}`, `updated_at: ${w(it.updated_at)}`,
      ];
    },
  },
  {
    name: 'get_spec',
    description: "The item's newest Spec text, and why the pipeline stopped if it did.",
    fields: ITEM_ID,
    required: ['item_id'],
    async run(ctx, _st, i) {
      await loadItem(ctx, i.item_id!);
      const a = await getWorkItemActivity(ctx, i.item_id!);
      return [
        `spec_version: ${w(a.spec?.version)}`, `spec: ${data(a.spec?.body)}`, `halted: ${a.halted ? 'yes' : 'no'}`,
        `notice: ${a.notice === null ? TOOL_NONE : data(a.notice.reason)}`,
      ];
    },
  },
  {
    name: 'get_run_activity',
    description: "The item's newest runs, oldest first: role, status, cost, summary, and the pipeline steps taken.",
    fields: ITEM_ID,
    required: ['item_id'],
    async run(ctx, _st, i) {
      await loadItem(ctx, i.item_id!);
      const a = await getWorkItemActivity(ctx, i.item_id!);
      const out = [`stage: ${ident(a.stage)}`, `pr_number: ${w(a.pr_number)}`];
      for (const r of a.runs) out.push(`run ${r.id} role=${ident(r.role)} status=${ident(r.status)} usd=${w(r.usd)} at=${w(r.created_at)} summary: ${data(r.summary)}`);
      for (const s of a.steps) out.push(`step ${ident(s.kind)} state=${ident(s.state)} result=${ident(s.result)} at=${w(s.at)}`);
      return out;
    },
  },
  {
    name: 'get_verdicts',
    description: "The item's review verdicts: each reviewer or tester run with its status and summary.",
    fields: ITEM_ID,
    required: ['item_id'],
    async run(ctx, _st, i) {
      await loadItem(ctx, i.item_id!);
      const a = await getWorkItemActivity(ctx, i.item_id!);
      const out = a.runs
        .filter((r) => VERDICT_ROLES.includes(r.role))
        .map((r) => `verdict run ${r.id} role=${ident(r.role)} status=${ident(r.status)} at=${w(r.created_at)} summary: ${data(r.summary)}`);
      return out.length === 0 ? ['no verdicts yet'] : out;
    },
  },
  {
    name: 'get_plan',
    description: "The repo's imported plan: milestones, totals and tasks, optionally one milestone or only done or remaining tasks.",
    fields: { milestone: { type: 'text', max: 80 }, status: { type: 'enum', values: ['done', 'remaining'] } },
    required: [],
    async run(ctx, _st, i) {
      const q = { limit: 40, ...(i.milestone !== undefined ? { milestone: i.milestone } : {}), ...(i.status !== undefined ? { status: i.status as 'done' | 'remaining' } : {}) };
      const p = await getPlanView(ctx, ctx.repoId, q);
      const out = [`totals: ${p.totals.tasks} tasks, ${p.totals.done} done, ${p.totals.remaining} remaining`];
      for (const m of p.milestones) out.push(`milestone ${data(m.key)} ${data(m.title)} done=${m.done} remaining=${m.remaining}`);
      for (const t of p.tasks) out.push(`task ${data(t.task_key)} ${data(t.title)} status=${ident(t.status)} planned_prs=${t.planned_prs} merged_prs=${t.merged_prs.join(',') || TOOL_NONE}`);
      if (p.next_cursor !== null) out.push('more tasks exist; narrow by milestone or status');
      return out;
    },
  },
  {
    name: 'list_corrections',
    description: "The item's corrections, oldest first: kind, who proposed it, status and text.",
    fields: ITEM_ID,
    required: ['item_id'],
    async run(ctx, _st, i) {
      await loadItem(ctx, i.item_id!);
      const rows = await listCorrections(ctx, i.item_id!);
      const out = rows.map((c) => `correction ${c.id} kind=${ident(c.kind)} origin=${ident(c.origin)} status=${ident(c.status)} at=${c.createdAt.toISOString()} body: ${data(c.body)}`);
      return out.length === 0 ? ['no corrections'] : out;
    },
  },
  {
    name: 'draft_correction',
    description: 'Propose a correction for the item. It is only a proposal: a person must accept it. Use it when the person asks you to write one down.',
    fields: { item_id: { type: 'uuid' }, kind: { type: 'enum', values: CORRECTION_KINDS }, body: { type: 'text', max: CORRECTION_BODY_MAX } },
    required: ['item_id', 'kind', 'body'],
    async run(ctx, st, i) {
      await loadItem(ctx, i.item_id!);
      // Model text: control tokens defanged before the write (the row is fenced again where a run uses it).
      const body = stripControlTokens(i.body!);
      if (body.trim() === '') throw new CorrectionInputError('empty');
      // The route's own check: a priority or new_item body that could never be accepted is refused here, not saved.
      checkBody(i.kind!, body, ctx.itemKinds);
      const key = createHash('sha256').update(`${i.item_id}\n${i.kind}\n${body}`).digest('hex');
      let id = st.drafts.get(key);
      if (id === undefined) {
        const c = await createCorrection(ctx, { workItemId: i.item_id!, kind: i.kind as (typeof CORRECTION_KINDS)[number], body, origin: 'agent' });
        id = c.id;
        st.drafts.set(key, id);
      }
      return [`correction ${id} is proposed. A person must accept it before anything happens.`];
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** The names the model may call. */
export const ASSISTANT_TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

/** The tool list handed to the model: strict schemas, unknown fields refused. */
export function assistantToolDefs(): AssistantToolDef[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: [...t.required],
      properties: Object.fromEntries(
        Object.entries(t.fields).map(([k, f]) => [
          k,
          f.type === 'uuid' ? { type: 'string', format: 'uuid' } : f.type === 'enum' ? { type: 'string', enum: [...f.values] } : { type: 'string', maxLength: f.max },
        ]),
      ),
    },
  }));
}

/** Strict check: only listed fields, all required present, every value a string of the right shape. Returns the first fault. */
function validate(t: Tool, input: unknown): { ok: true; value: Record<string, string> } | { ok: false; fault: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, fault: 'input must be an object' };
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!Object.hasOwn(t.fields, k)) return { ok: false, fault: 'unknown field' };
  for (const k of t.required) if (!Object.hasOwn(o, k)) return { ok: false, fault: `missing field ${k}` };
  const value: Record<string, string> = {};
  for (const [k, f] of Object.entries(t.fields)) {
    if (!Object.hasOwn(o, k)) continue;
    const v = o[k];
    if (typeof v !== 'string') return { ok: false, fault: `${k} must be text` };
    if (f.type === 'uuid' && !UUID_RE.test(v)) return { ok: false, fault: `${k} must be an id` };
    if (f.type === 'enum' && !f.values.includes(v)) return { ok: false, fault: `${k} is not one of the allowed values` };
    if (f.type === 'text' && Array.from(v).length > f.max) return { ok: false, fault: `${k} is too long` };
    value[k] = v;
  }
  return { ok: true, value };
}

function clip(lines: readonly string[]): string {
  const out: string[] = [];
  let n = 0;
  for (const l of lines) {
    n += l.length + 1;
    if (n > TOOL_RESULT_MAX) {
      out.push('[more not shown]');
      break;
    }
    out.push(l);
  }
  return out.join('\n');
}

/**
 * Runs one tool call. Returns null for a name outside the registry: the call is dropped, never run. A bad input, a missing
 * item or another repo's item comes back as an error result the model can read; any other failure (a database fault) propagates.
 */
export async function runAssistantTool(ctx: AssistantToolCtx, st: AssistantTurnState, name: string, input: unknown): Promise<AssistantToolResult | null> {
  const t = BY_NAME.get(name);
  if (t === undefined) return null;
  const v = validate(t, input);
  if (!v.ok) return { text: `invalid input: ${v.fault}`, isError: true };
  try {
    return { text: clip(await t.run(ctx, st, v.value)), isError: false };
  } catch (err) {
    if (err instanceof NotFoundError) return { text: NOT_FOUND, isError: true };
    if (err instanceof CorrectionInputError) return { text: 'invalid input: body', isError: true };
    throw err;
  }
}
