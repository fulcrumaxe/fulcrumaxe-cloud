import type { PoolClient } from 'pg';
import type { PresetName } from '@fx/decisions';
import { getCurrentDialSetting } from '@fx/db/src/decisions.js';
import { startGateOf, type StartDecisionType } from '@fx/db/src/startGate.js';
import { START_CATEGORIES, resolveStart, type StartCategory, type StartOwnerProcess } from '../autonomy/resolveStart.js';
import { withTenant } from '../tenancy/withTenant.js';
import { raiseStartAsk, recordStartReceipt, type StartGateCtx, type StartGateResult } from './startGate.js';

/**
 * D#7 start gate, part (b): WHETHER an item starts, and what is recorded when it does. Called by the stage driver at the end of triage, at the entry of
 * the short Spec and at the entry of a build, with the origin of the advance named by the caller:
 *
 *  - `person_click`: the advance was filed by a signed-in owner or admin pressing a button (every advance the driver performs today: `performDriven`
 *    refuses anything else). The click IS the decision. A small, bug or doc start and a build record a PERSON start receipt and never raise an ask. A click
 *    on a pair whose row is `asked` answers that ask; on a `declined` pair it decides again (the person always wins). One exception: an item that came
 *    in as small, bug or doc and that triage then classifies as feature or critical (`start_after_reclassify`, class 3) is ALWAYS asked, click or not,
 *    because the person approved a smaller job than the one found.
 *  - `unattended`: nobody clicked (the auto-start sweep, R1b). The item's dial decides, through `resolveStart`: act or announce records a `policy`
 *    start receipt (class 2 only) and the item continues; ask raises one start ask and the item waits. Feature, critical and reclassified items always ask.
 *    A hold (`declined`) is never overridden by the dial.
 *
 * The dial: a repository with no dial row for the start type is Balanced (owner ruling, 10-25), whatever the catalogue's own default is. The ruling is
 * applied HERE, as an explicit override; the catalogue defaults and `decide()` are untouched. A row's disposition maps to the preset that produces it
 * (ask = cautious, announce = balanced, act = autonomous), which `resolveStart` reads. Class 3 types are `ask` under every preset.
 *
 * The hard rules of `resolveStart` that guard an UNATTENDED auto-start (not_checked, free_preview, no_write_install, engine_loop_repo,
 * external_needs_approval) are not applied here: a person's click, and a triage the person approved, are not auto-starts, and R1b owns them. The fixed
 * invariants still win: an item that is not internal (`untrusted_work_creation`) or that the repository's own loop owns (`owned_by_internal_loop`) is
 * never started and records nothing.
 */
export type StartOrigin = 'person_click' | 'unattended';

export interface DecideStartInput {
  workItemId: string;
  origin: StartOrigin;
  /** The signed-in person; required for `person_click`, ignored for `unattended`. */
  userId?: string;
  /** The category triage produced, or the item's kind. Null: read from the item's discussion (the build entry knows only the item). */
  category: string | null;
  /** The category the item came in as (a trusted label), when it was small, bug or doc. */
  cameInAs?: string | null;
}

export type StartHow = 'person_receipt' | 'policy_receipt' | 'already_started' | 'answered_ask' | 'not_gated';
export type StartHeld = 'asked' | 'held' | 'blocked';
export type DecideStartResult =
  | { proceed: true; how: StartHow; decisionType: StartDecisionType | null; receiptId: string | null; preset: PresetName | null; announce: boolean }
  | { proceed: false; reason: StartHeld; decisionType: StartDecisionType | null; askId: string | null; blockedBy: string | null };

const SMALL = ['small', 'bug', 'doc'] as const;
const LARGER = ['feature', 'critical'] as const;
const isSmall = (c: string | null | undefined): c is (typeof SMALL)[number] => c != null && (SMALL as readonly string[]).includes(c);
const isLarger = (c: string | null | undefined): c is (typeof LARGER)[number] => c != null && (LARGER as readonly string[]).includes(c);

/** The preset a disposition comes from: class 2 is the only class presets move, so the mapping is lossless. */
const PRESET_OF_DISPOSITION: Readonly<Record<string, PresetName>> = { ask: 'cautious', announce: 'balanced', act: 'autonomous' };
/** Owner ruling 10-25: no dial row for a start type is Balanced. */
const NO_DIAL_ROW_PRESET: PresetName = 'balanced';

interface ItemFacts {
  provenance: string;
  repoId: string | null;
  kind: string | null;
  ownerProcess: string | null;
}

async function readItem(client: PoolClient, accountId: string, workItemId: string): Promise<ItemFacts | null> {
  const r = await client.query<{ provenance: string; repo_id: string | null; kind: string | null }>(
    `SELECT w.provenance, w.repo_id, d.kind
       FROM work_items w LEFT JOIN discussions d ON d.account_id = w.account_id AND d.id = w.discussion_id
      WHERE w.id = $1::uuid AND w.account_id = $2::uuid`,
    [workItemId, accountId],
  );
  const row = r.rows[0];
  if (!row) return null;
  // The proposal's owner is read on its own (the item's provenance is the item's; `workItemOrigin` stays the one path that joins the two).
  const owner = await client.query<{ owner_process: string }>('SELECT owner_process FROM proposals WHERE account_id = $1::uuid AND work_item_id = $2::uuid LIMIT 1', [accountId, workItemId]);
  return { provenance: row.provenance, repoId: row.repo_id, kind: row.kind, ownerProcess: owner.rows[0]?.owner_process ?? null };
}

/** The preset of the repo's dial for one class 2 start type: the row's disposition, or Balanced with no row (owner ruling 10-25). */
async function presetFor(client: PoolClient, repoId: string | null, smallKind: (typeof SMALL)[number]): Promise<PresetName> {
  const row = repoId === null ? null : await getCurrentDialSetting(client, repoId, `start_work_${smallKind}`);
  // Only the ABSENCE of a row is Balanced. A row whose disposition is not one we know is read the safe way: ask (Cautious).
  if (!row) return NO_DIAL_ROW_PRESET;
  return PRESET_OF_DISPOSITION[row.disposition] ?? 'cautious';
}

const held = (reason: StartHeld, decisionType: StartDecisionType | null, askId: string | null = null, blockedBy: string | null = null): DecideStartResult =>
  ({ proceed: false, reason, decisionType, askId, blockedBy });

export async function decideStart(ctx: StartGateCtx, input: DecideStartInput): Promise<DecideStartResult> {
  if (input.origin === 'person_click' && !input.userId) throw new Error('decideStart: a person_click needs the person');
  const facts = await withTenant(ctx.pool, ctx.accountId, (client) => readItem(client, ctx.accountId, input.workItemId));
  if (facts === null) throw new Error('decideStart: no such work item');
  // The fixed invariants win over every dial and every click.
  if (facts.provenance !== 'internal') return held('blocked', null, null, 'untrusted_work_creation');
  if (facts.ownerProcess !== null && facts.ownerProcess !== 'product') return held('blocked', null, null, 'owned_by_internal_loop');

  const category = input.category ?? facts.kind;
  const reclassified = isSmall(input.cameInAs) && isLarger(category);
  let decisionType: StartDecisionType;
  if (reclassified) decisionType = 'start_after_reclassify';
  else if (isSmall(category)) decisionType = `start_work_${category}` as StartDecisionType;
  else if (isLarger(category)) decisionType = 'start_parent_item';
  else return { proceed: true, how: 'not_gated', decisionType: null, receiptId: null, preset: null, announce: false };

  // Class 3 types are `ask` under every preset; the preset stored with them is the repo's dial for the kind the item came in as (Balanced when unknown).
  const dialKind = reclassified ? (input.cameInAs as (typeof SMALL)[number]) : isSmall(category) ? category : 'small';
  const preset = await withTenant(ctx.pool, ctx.accountId, (client) => presetFor(client, facts.repoId, dialKind));
  const resolved = resolveStart({
    preset,
    ownerProcess: 'product' satisfies StartOwnerProcess,
    engineLoopRepo: false,
    provenance: 'internal',
    verification: 'verified',
    category: ((START_CATEGORIES as readonly string[]).includes(category ?? '') ? category : null) as StartCategory | null,
    freePreview: false,
    hasWriteInstall: true,
  });
  const gateInput = { workItemId: input.workItemId, decisionType, preset };

  const started = (r: StartGateResult, how: StartHow): DecideStartResult => ({
    proceed: true, how: r.replayed ? 'already_started' : how, decisionType, receiptId: r.receiptId, preset, announce: how === 'policy_receipt' && !r.replayed && resolved.outcome === 'announce',
  });
  const afterAsk = (r: StartGateResult): DecideStartResult =>
    r.outcome === 'started' ? started(r, 'already_started') : r.outcome === 'declined' ? held('held', decisionType, r.askId) : held('asked', decisionType, r.askId);

  // The click decides, except for a start the person did not approve (a larger job than the one they clicked for).
  if (input.origin === 'person_click' && !reclassified) {
    const r = await recordStartReceipt({ ...ctx, userId: input.userId }, gateInput);
    return started(r, r.askId !== null ? 'answered_ask' : 'person_receipt');
  }
  // Unattended, or a reclassified item: the resolver says go or ask.
  if (resolved.outcome === 'refused') return held('blocked', decisionType, null, resolved.reason);
  if (!reclassified && (resolved.outcome === 'act' || resolved.outcome === 'announce') && decisionType !== 'start_parent_item') {
    const r = await recordStartReceipt(ctx, gateInput);
    // A hold or an open ask already on the pair stands: the dial does not override it.
    return r.outcome === 'started' ? started(r, 'policy_receipt') : r.outcome === 'declined' ? held('held', decisionType, r.askId) : held('asked', decisionType, r.askId);
  }
  return afterAsk(await raiseStartAsk(ctx, gateInput));
}

/**
 * The spec entry of an advance NOBODY clicked (a restart: the parked-stage sweep, the slot wake): the pair of the reclassify ask is only looked at, never
 * answered. No pair, or a started one, goes on. A held (`declined`) pair stays held. An open ask stays open, and a withdrawn pair is asked again (class 3 always
 * asks; the definer lets only the policy raise it). Nothing here records a person's receipt.
 */
export async function checkStartPair(ctx: StartGateCtx, input: { workItemId: string; decisionType?: StartDecisionType }): Promise<DecideStartResult> {
  const decisionType = input.decisionType ?? 'start_after_reclassify';
  const row = await withTenant(ctx.pool, ctx.accountId, (client) => startGateOf(client, input.workItemId, decisionType));
  if (row === null) return { proceed: true, how: 'not_gated', decisionType: null, receiptId: null, preset: null, announce: false };
  if (row.outcome === 'started') return { proceed: true, how: 'already_started', decisionType, receiptId: row.receiptId, preset: null, announce: false };
  if (row.outcome === 'declined') return held('held', decisionType, row.askId);
  const r = await raiseStartAsk(ctx, { workItemId: input.workItemId, decisionType, preset: 'balanced' });
  if (r.outcome === 'started') return { proceed: true, how: 'already_started', decisionType, receiptId: r.receiptId, preset: null, announce: false };
  return r.outcome === 'declined' ? held('held', decisionType, r.askId) : held('asked', decisionType, r.askId);
}

/**
 * A person's click on an item that already has a start pair which is not started (the spec entry, after a reclassify ask was held or left open): the click
 * answers the open ask or decides the held pair again. Nothing is written for an item with no such pair.
 */
export async function settleStartClick(ctx: StartGateCtx, input: { workItemId: string; userId: string; decisionType?: StartDecisionType }): Promise<DecideStartResult> {
  const decisionType = input.decisionType ?? 'start_after_reclassify';
  const row = await withTenant(ctx.pool, ctx.accountId, (client) => startGateOf(client, input.workItemId, decisionType));
  if (row === null || row.outcome === 'started') return { proceed: true, how: 'not_gated', decisionType: null, receiptId: null, preset: null, announce: false };
  const r = await recordStartReceipt({ ...ctx, userId: input.userId }, { workItemId: input.workItemId, decisionType, preset: 'balanced' });
  return { proceed: true, how: r.askId !== null ? 'answered_ask' : 'person_receipt', decisionType, receiptId: r.receiptId, preset: 'balanced', announce: false };
}
