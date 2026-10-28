import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { catalogueClassOf, keySubItemAsk } from '@fx/db/src/decisionAsks.js';
import { raiseAskMarked } from './raiseAskMarked.js';
import { getCurrentDialSetting } from '@fx/db/src/decisions.js';
import { DIAL_VERSION_CATALOGUE_DEFAULT, writeSubItemPolicyReceipt } from '@fx/db/src/receiptWriter.js';
import { sanitize } from '@fx/trust';
import { resolveSubItemLaunch } from '../autonomy/resolveSubItemLaunch.js';
import { cleanWorkItemTitle } from '../work-items/title.js';
import { FIX_ASK_HOLD, FIX_ASK_START, presetOf } from './fixRoundGate.js';

/**
 * D#483 S5-b2c-1: when a planned PR child may launch, in ONE place. The rule itself is the database's (`planned_pr_child_blocker`, migration 0920, which the dial's
 * definer runs again at the data); this file words it, adds the one check that needs a price (the parent's envelope), and decides what the dial and a person do.
 *
 *   - `readChildLaunch`: the child card's read. Nothing is stored: the reason is derived from the rows as they are now, so it clears when the thing it names clears.
 *   - `gateChildLaunch`: one child through the dial, in a transaction the caller owns on the RECEIPT login with no person in the session. It launches (the keyed policy
 *     receipt, then `dial_launch_child`), asks (one ask per parent and key), or says why not.
 *   - `prepareChildLaunch` / `fileChildLaunch`: a person's Approve on a planned PR key (called from `approveSubItemIn`, in the person's own session).
 *
 * `dialFiled` means unattended: the request the definer files is keyed `dial:<receipt>`, which is how the driver tells the dial's start from a person's click. A dial
 * launch is never `personFiled`. A person's launch is filed in the person's own name under a key of its own.
 */

/** The fixed reasons a child does not launch, section 2 of the Spec. Each has one sentence (`CHILD_LAUNCH_SENTENCES`). */
export const CHILD_LAUNCH_CODES = [
  'child_orphaned',
  'parent_closed',
  'respec_needs_approval',
  'key_not_in_approved_spec',
  'waiting_on_planned_pr',
  'external_needs_approval',
  'parent_no_envelope',
  'parent_envelope_reached',
  'child_build_unsupported',
  'child_closed',
] as const;
export type ChildLaunchCode = (typeof CHILD_LAUNCH_CODES)[number];

/** Every code `dial_launch_child` can raise as a 55000 message (migration 0920), so each has a sentence. */
export const DIAL_LAUNCH_CHILD_ERROR_CODES = [
  'account_not_active',
  'receipt_not_in_transaction',
  'receipt_mismatch',
  'child_orphaned',
  'parent_closed',
  'respec_needs_approval',
  'key_not_in_approved_spec',
  'external_needs_approval',
  'parent_no_envelope',
  'work_started',
  'child_closed',
  'autostart_off',
  'autostart_confirmer_not_admin',
  'envelope_already_set',
  'not_a_child',
] as const;

const NOT_YET = "Planned PRs can't start yet.";

/**
 * The one map from a reason to its sentence. `<sibling title>` and `<parent title>` stand for the CLEANED title of that item (`childLaunchSentence` fills them);
 * no sentence prints an id, a stored title as it was typed, or a database message.
 */
export const CHILD_LAUNCH_SENTENCES: Readonly<Record<ChildLaunchCode | (typeof DIAL_LAUNCH_CHILD_ERROR_CODES)[number], string>> = Object.freeze({
  child_orphaned: 'The item this planned PR belonged to was deleted.',
  parent_closed: 'The item this planned PR belongs to is closed.',
  respec_needs_approval: 'The Spec changed. It needs approval again before more planned PRs start.',
  key_not_in_approved_spec: 'This planned PR is no longer in the approved Spec.',
  waiting_on_planned_pr: 'Waits for <sibling title> to merge.',
  external_needs_approval: 'This planned PR came from outside your team, so a person has to approve it before it starts.',
  parent_no_envelope: 'This planned PR has no spending limit to draw on. Set one on <parent title>.',
  parent_envelope_reached: "This item's spending limit is used up. Nothing more starts until you raise the limit or stop the item.",
  child_build_unsupported: NOT_YET,
  child_closed: 'This planned PR was closed.',
  // The definer's own refusals that a person never needs to act on: the planned PR waits and the next pass looks again.
  account_not_active: NOT_YET,
  receipt_not_in_transaction: NOT_YET,
  receipt_mismatch: NOT_YET,
  work_started: 'This planned PR has already started.',
  autostart_off: 'Automatic starts are off, so a person has to start this planned PR.',
  autostart_confirmer_not_admin: 'Automatic starts need an owner or admin to confirm the weekly limit again.',
  envelope_already_set: NOT_YET,
  not_a_child: NOT_YET,
});

const FALLBACK_TITLE = 'another planned PR';
const FALLBACK_PARENT = 'the item it belongs to';

/** The sentence for a code, with the titles cleaned by `cleanWorkItemTitle` (an untrusted title never reaches the screen as it was stored). */
export function childLaunchSentence(code: keyof typeof CHILD_LAUNCH_SENTENCES, titles: { siblingTitle?: unknown; parentTitle?: unknown } = {}): string {
  const sibling = cleanWorkItemTitle(titles.siblingTitle) ?? FALLBACK_TITLE;
  const parent = cleanWorkItemTitle(titles.parentTitle) ?? FALLBACK_PARENT;
  return CHILD_LAUNCH_SENTENCES[code].replace('<sibling title>', () => sibling).replace('<parent title>', () => parent);
}

const isChildCode = (c: string): c is ChildLaunchCode => (CHILD_LAUNCH_CODES as readonly string[]).includes(c);

/** The pieces the launch needs from outside this package: the build's readiness (the pairing guard) and the parent envelope's room (needs a price, which is the pipeline's). */
export interface ChildLaunchDeps {
  /** `CHILD_BUILD_SUPPORTED` from the pipeline. False or absent: nothing is filed. */
  buildSupported: boolean;
  /** Room under the parent's envelope for the child's first run, decided under the envelope's lock. `priceUsd` is p(executor) for the repo. */
  room(client: PoolClient, input: { accountId: string; repoId: string; envelopeId: string; childId: string }): Promise<{ fits: boolean; remainingUsd: number; priceUsd: number }>;
}

interface ChildRow { id: string; parent_id: string | null; repo_id: string | null; planned_pr_key: string; planned_pr_spec_version_id: string | null; title: string | null }

const lockChild = (client: PoolClient, accountId: string, childId: string): Promise<unknown> =>
  client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`child_launch:${accountId}:${childId}`]);

async function blockerOf(client: PoolClient, childId: string, skipWaiting: boolean, skipExternal: boolean): Promise<string | null> {
  const { rows } = await client.query<{ b: string | null }>('SELECT planned_pr_child_blocker($1::uuid, $2::boolean, $3::boolean) AS b', [childId, skipWaiting, skipExternal]);
  return rows[0]?.b ?? null;
}

async function readChild(client: PoolClient, accountId: string, childId: string): Promise<ChildRow | null> {
  const { rows } = await client.query<ChildRow>(
    `SELECT id, parent_id, repo_id, planned_pr_key, planned_pr_spec_version_id, title FROM work_items WHERE id = $1::uuid AND account_id = $2::uuid AND planned_pr_key IS NOT NULL`, [childId, accountId]);
  return rows[0] ?? null;
}

/** The planned PR child of `parentId` with this key, or null (a key that names no child is a sub-item key of some other kind). */
export async function findPlannedChild(client: PoolClient, accountId: string, parentId: string, key: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM work_items WHERE account_id = $1::uuid AND parent_id = $2::uuid AND planned_pr_key = $3::text`, [accountId, parentId, key]);
  return rows[0]?.id ?? null;
}

async function parentEnvelope(client: PoolClient, accountId: string, parentId: string): Promise<string | null> {
  const { rows } = await client.query<{ envelope_id: string | null }>('SELECT envelope_id FROM work_items WHERE id = $1::uuid AND account_id = $2::uuid', [parentId, accountId]);
  return rows[0]?.envelope_id ?? null;
}

export interface ChildLaunchState {
  /** The first reason the child does not launch, or null when it may. */
  code: ChildLaunchCode | null;
  sentence: string | null;
  /** What the card offers with the sentence. */
  offers: 'close' | 'parent' | null;
  /** For a person's launch: the child still waits on a sibling (the card warns; a person may start it out of order). */
  warning: { code: 'waiting_on_planned_pr'; sentence: string } | null;
  started: boolean;
}

const OFFERS: Readonly<Partial<Record<ChildLaunchCode, 'close' | 'parent'>>> = {
  child_orphaned: 'close', parent_closed: 'close', key_not_in_approved_spec: 'close', child_closed: 'close', respec_needs_approval: 'parent',
};

async function titlesFor(client: PoolClient, accountId: string, child: ChildRow): Promise<{ siblingTitle: string | null; parentTitle: string | null }> {
  const waiting = await client.query<{ w: string[] }>('SELECT planned_pr_child_waiting_on($1::uuid) AS w', [child.id]);
  const dep = waiting.rows[0]?.w?.[0];
  const sibling = dep && child.parent_id
    ? (await client.query<{ title: string | null }>('SELECT title FROM work_items WHERE account_id = $1::uuid AND parent_id = $2::uuid AND planned_pr_key = $3::text', [accountId, child.parent_id, dep])).rows[0]?.title ?? null
    : null;
  const parent = child.parent_id
    ? (await client.query<{ title: string | null }>('SELECT title FROM work_items WHERE account_id = $1::uuid AND id = $2::uuid', [accountId, child.parent_id])).rows[0]?.title ?? null
    : null;
  return { siblingTitle: sibling, parentTitle: parent };
}

/**
 * The child card's read: why the child does not launch (the fixed sentence), or that it may. `person` reads it the way a person's Approve does: the sibling hold is
 * a warning, not a block, and an external child is not held. `deps` adds the envelope check; without it that one check (8) is not made.
 * Must run in a `withTenant` transaction.
 */
export async function readChildLaunch(client: PoolClient, input: { accountId: string; childId: string; person?: boolean; deps?: Pick<ChildLaunchDeps, 'room'> }): Promise<ChildLaunchState> {
  const { accountId, childId } = input;
  const person = input.person === true;
  const child = await readChild(client, accountId, childId);
  const none: ChildLaunchState = { code: null, sentence: null, offers: null, warning: null, started: false };
  if (child === null) return none;
  const raw = await blockerOf(client, childId, person, person);
  if (raw === 'work_started') return { ...none, started: true };
  let code: string | null = raw;
  if (code === null && input.deps !== undefined && child.parent_id !== null && child.repo_id !== null) {
    const envelopeId = await parentEnvelope(client, accountId, child.parent_id);
    if (envelopeId !== null) {
      const room = await input.deps.room(client, { accountId, repoId: child.repo_id, envelopeId, childId });
      if (!room.fits) code = 'parent_envelope_reached';
    }
  }
  const titles = await titlesFor(client, accountId, child);
  let warning: ChildLaunchState['warning'] = null;
  if (person && code === null && (await blockerOf(client, childId, false, true)) === 'waiting_on_planned_pr') {
    warning = { code: 'waiting_on_planned_pr', sentence: childLaunchSentence('waiting_on_planned_pr', titles) };
  }
  if (code === null || !isChildCode(code)) return { ...none, warning };
  return { code, sentence: childLaunchSentence(code, titles), offers: OFFERS[code] ?? null, warning, started: false };
}

// ---- a person's launch ------------------------------------------------------------------------------------------------------------------------

export class ChildLaunchRefusal extends Error {
  constructor(readonly code: ChildLaunchCode) {
    super(code);
    this.name = 'ChildLaunchRefusal';
  }
}

export interface PreparedChildLaunch {
  childId: string;
  /** False for a child that already started: the Approve is a replay and files nothing. */
  launch: boolean;
}

/**
 * A person's Approve on a planned PR key, before anything is written: the pairing guard, then checks 1 to 4 and 7 to 9. The sibling hold (5) and the external
 * hold (6) do not stop a person. Throws `ChildLaunchRefusal` (the whole approval then rolls back, so a refusal leaves nothing). Takes the child's lock, then the
 * envelope's (the same order as the dial, so two launches cannot deadlock).
 */
export async function prepareChildLaunch(client: PoolClient, input: { accountId: string; childId: string; deps: ChildLaunchDeps | undefined }): Promise<PreparedChildLaunch> {
  const { accountId, childId, deps } = input;
  if (deps === undefined || deps.buildSupported !== true) throw new ChildLaunchRefusal('child_build_unsupported');
  await lockChild(client, accountId, childId);
  const child = await readChild(client, accountId, childId);
  if (child === null) throw new ChildLaunchRefusal('child_orphaned');
  const code = await blockerOf(client, childId, true, true);
  if (code === 'work_started') return { childId, launch: false };
  if (code !== null) {
    if (!isChildCode(code)) throw new ChildLaunchRefusal('child_orphaned');
    throw new ChildLaunchRefusal(code);
  }
  const envelopeId = child.parent_id === null ? null : await parentEnvelope(client, accountId, child.parent_id);
  if (envelopeId === null || child.repo_id === null) throw new ChildLaunchRefusal('parent_no_envelope');
  const room = await deps.room(client, { accountId, repoId: child.repo_id, envelopeId, childId });
  if (!room.fits) throw new ChildLaunchRefusal('parent_envelope_reached');
  return { childId, launch: true };
}

/**
 * After the person's receipt is written: point the child at its parent's envelope and file `advance_work_item` for it in the person's own name (session principal;
 * the driver reads that as a person's click). The key counts the child's earlier requests, so a launch after a cancelled run is a new request and a replay of the
 * same click (the child is then started, so `prepareChildLaunch` answered `launch: false`) files nothing.
 */
export async function fileChildLaunch(client: PoolClient, input: { accountId: string; childId: string }): Promise<string> {
  const { accountId, childId } = input;
  await client.query('SELECT work_item_set_child_envelope($1::uuid)', [childId]);
  const n = Number((await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM run_action_requests WHERE account_id = $1::uuid AND kind = 'advance_work_item' AND target_id = $2::uuid`, [accountId, childId])).rows[0]!.n);
  const req = await client.query<{ action_id: string }>('SELECT action_id FROM run_action_request($1, $2, $3, $4)',
    ['advance_work_item', childId, `child:${childId}:${n + 1}`, createHash('sha256').update(`advance_work_item:${childId}`).digest('hex')]);
  return req.rows[0]!.action_id;
}

// ---- the dial's launch ------------------------------------------------------------------------------------------------------------------------

export type ChildGateOutcome = 'started' | 'asked' | 'held_by_rule' | 'no_room' | 'not_ready' | 'replayed';
export interface ChildGateResult {
  outcome: ChildGateOutcome;
  /** With `held_by_rule` (and `no_room`): the section 2 reason. */
  code?: ChildLaunchCode;
}

export const CHILD_ASK_START_LABEL = 'Start it';
export const CHILD_ASK_HOLD_LABEL = 'Hold it for now';

/** The definer refusals that mean "this one, not now" (the transaction rolled back, nothing is left behind). */
const DEFINER_HELD: ReadonlySet<string> = new Set(['child_orphaned', 'parent_closed', 'respec_needs_approval', 'key_not_in_approved_spec', 'external_needs_approval', 'parent_no_envelope', 'child_closed']);
const DEFINER_REPLAY: ReadonlySet<string> = new Set(['work_started', 'receipt_not_in_transaction']);

/** Maps what `dial_launch_child` raised to an outcome, or rethrows what is not one of its fixed refusals. */
export function childGateOutcomeOfError(err: unknown): ChildGateResult {
  const e = err as { code?: string; message?: string } | null;
  if (e?.code === '23505') return { outcome: 'replayed' };
  if (e?.code === '42501') return { outcome: 'not_ready' };
  if (e?.code === '55000' && typeof e.message === 'string') {
    if (DEFINER_REPLAY.has(e.message)) return { outcome: 'replayed' };
    if (DEFINER_HELD.has(e.message) && isChildCode(e.message)) return { outcome: 'held_by_rule', code: e.message };
    if ((DIAL_LAUNCH_CHILD_ERROR_CODES as readonly string[]).includes(e.message)) return { outcome: 'not_ready' };
  }
  throw err;
}

/**
 * One child through the dial, inside a transaction on the RECEIPT login with the tenant set and NO person or token in the session (the keyed policy receipt and
 * `dial_launch_child` both refuse one). Anything this does not recognise ends in `not_ready` or an ask, never a start. A refusal at the database rolls the whole
 * transaction back (the caller maps it with `childGateOutcomeOfError`), so a half launch cannot exist.
 */
export async function gateChildLaunch(client: PoolClient, input: { accountId: string; childId: string; deps: ChildLaunchDeps | undefined }): Promise<ChildGateResult> {
  const { accountId, childId, deps } = input;
  await lockChild(client, accountId, childId);
  const child = await readChild(client, accountId, childId);
  if (child === null) return { outcome: 'not_ready' };
  const blocker = await blockerOf(client, childId, false, false);
  if (blocker === 'work_started') return { outcome: 'replayed' };
  if (blocker !== null) return isChildCode(blocker) ? { outcome: 'held_by_rule', code: blocker } : { outcome: 'not_ready' };
  // The reasons are derived above; nothing below this line writes until the build supports a child.
  if (deps === undefined || deps.buildSupported !== true) return { outcome: 'not_ready' };
  if (child.parent_id === null || child.repo_id === null || child.planned_pr_spec_version_id === null) return { outcome: 'not_ready' };

  const parentId = child.parent_id;
  const envelopeId = await parentEnvelope(client, accountId, parentId);
  if (envelopeId === null) return { outcome: 'held_by_rule', code: 'parent_no_envelope' };
  const facts = (await client.query<{ approval_id: string; approved_version: number; current_version: number; keys: string[]; owner_process: string | null }>(
    `SELECT a.id AS approval_id, av.version AS approved_version, cv.version AS current_version,
            COALESCE((SELECT array_agg(e ->> 'key') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(av.frontmatter -> 'planned_prs') = 'array' THEN av.frontmatter -> 'planned_prs' ELSE '[]'::jsonb END) e), ARRAY[]::text[]) AS keys,
            (SELECT p.owner_process FROM proposals p WHERE p.account_id = $1::uuid AND p.work_item_id = $2::uuid LIMIT 1) AS owner_process
       FROM work_item_approvals a
       JOIN spec_versions av ON av.account_id = a.account_id AND av.id = a.spec_version_id
       JOIN LATERAL (SELECT s.version FROM spec_versions s WHERE s.account_id = a.account_id AND s.work_item_id = a.work_item_id AND s.erased_at IS NULL ORDER BY s.version DESC LIMIT 1) cv ON true
      WHERE a.account_id = $1::uuid AND a.work_item_id = $2::uuid ORDER BY a.created_at DESC, a.id DESC LIMIT 1`, [accountId, parentId])).rows[0];
  if (facts === undefined) return { outcome: 'held_by_rule', code: 'respec_needs_approval' };

  const room = await deps.room(client, { accountId, repoId: child.repo_id, envelopeId, childId });
  if (!Number.isFinite(room.priceUsd) || room.priceUsd <= 0) return { outcome: 'not_ready' };
  const dial = await getCurrentDialSetting(client, child.repo_id, 'launch_sub_item');
  const decision = resolveSubItemLaunch({
    preset: presetOf(dial?.disposition),
    parent: {
      ownerProcess: (facts.owner_process ?? 'product') as 'product', engineLoopRepo: false, provenance: 'internal', hasPersonApproval: true,
      approvedSpecVersion: facts.approved_version, currentSpecVersion: facts.current_version, envelopeRemainingUsd: room.remainingUsd,
    },
    sub: { kind: 'planned_pr', key: child.planned_pr_key, category: null },
    approvedSpecKeys: facts.keys,
    firstRunReservationUsd: room.priceUsd,
    asNewItem: { verification: 'verified', freePreview: false, hasWriteInstall: true },
  });
  // Case (d): a key the approved version does not list is never a new item.
  if (decision.outcome === 'new_item') return { outcome: 'held_by_rule', code: 'key_not_in_approved_spec' };
  if (decision.outcome === 'wait') return { outcome: 'no_room', code: 'parent_envelope_reached' };
  if (decision.outcome === 'refused') return { outcome: 'not_ready' };
  if (decision.outcome === 'ask' && decision.reason !== 'dial') return { outcome: 'not_ready' };

  // The run that published the approved version anchors both the receipt and an ask: the project manager's, else any run of this parent on that version.
  const anchor = (await client.query<{ id: string }>(
    `SELECT id FROM agent_runs WHERE account_id = $1::uuid AND work_item_id = $2::uuid AND spec_version_id = $3::uuid
      ORDER BY (role = 'project-manager') DESC, created_at DESC, id DESC LIMIT 1`, [accountId, parentId, child.planned_pr_spec_version_id])).rows[0]?.id;
  if (anchor === undefined) return { outcome: 'not_ready' };

  if (decision.outcome === 'ask') return askForChild(client, { accountId, parentId, child, anchor, preset: presetOf(dial?.disposition) });

  const receipt = await writeSubItemPolicyReceipt(client, {
    runId: anchor, workItemId: parentId, key: child.planned_pr_key, specVersionId: child.planned_pr_spec_version_id, approvalId: facts.approval_id,
    chosen: decision.outcome === 'announce' ? 'announce' : 'launch', dialVersion: dial?.version ?? DIAL_VERSION_CATALOGUE_DEFAULT,
  });
  if (receipt.replayed) return { outcome: 'replayed' };
  const launched = (await client.query<{ replayed: boolean }>('SELECT replayed FROM dial_launch_child($1::uuid, $2::uuid)', [childId, receipt.id])).rows[0]!;
  return { outcome: launched.replayed ? 'replayed' : 'started' };
}

/** One ask per (parent, key): "Start planned PR: <cleaned title>?", anchored on the run that published the approved version. A second pass finds it and raises none. */
async function askForChild(client: PoolClient, input: { accountId: string; parentId: string; child: ChildRow; anchor: string; preset: ReturnType<typeof presetOf> }): Promise<ChildGateResult> {
  const { accountId, parentId, child, anchor, preset } = input;
  // One ask per (parent, key) for the version being asked about (its anchor run): a live ask is found, and so is one a person already answered (a hold stays held,
  // it is not asked again every pass). An ask on an older version's run, or one that was withdrawn, does not stop a new one.
  const open = await client.query(
    `SELECT 1 FROM decision_asks WHERE account_id = $1::uuid AND work_item_id = $2::uuid AND decision_type = 'launch_sub_item' AND sub_item_key = $3::text
        AND state IN ('open', 'overdue', 'answered') AND run_id = $4::uuid LIMIT 1`,
    [accountId, parentId, child.planned_pr_key, anchor]);
  if (open.rows.length > 0) return { outcome: 'asked' };
  const cls = catalogueClassOf('launch_sub_item');
  if (cls === null || cls === 'automated_with_monitoring') return { outcome: 'not_ready' };
  const title = cleanWorkItemTitle(child.title) ?? child.planned_pr_key;
  const rationale = sanitize(`Start planned PR: ${title}? Your setting asks before a planned PR starts. Nothing starts until you answer: start it, or hold it.`);
  const askId = await raiseAskMarked(client, {
    class: cls, decisionType: 'launch_sub_item', workItemId: parentId, runId: anchor,
    // The answer path is the sub-item one (answerAsk starts on `FIX_ASK_START`), so the option ids are shared with the fix rounds; only the words differ.
    options: [{ id: FIX_ASK_START, label: CHILD_ASK_START_LABEL }, { id: FIX_ASK_HOLD, label: CHILD_ASK_HOLD_LABEL }],
    proposed: FIX_ASK_START, rationale, quotedInputs: [{ trust: 'untrusted', storedBody: rationale }], preset,
  });
  if (!(await keySubItemAsk(client, askId, child.planned_pr_key))) throw new Error('childLaunch: the new ask could not be keyed');
  return { outcome: 'asked' };
}
