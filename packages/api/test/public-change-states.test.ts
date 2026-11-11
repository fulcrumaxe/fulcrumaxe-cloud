import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { BRANCH_CLEANUP_SENTENCE, getWorkItemActivity } from '@fx/core/src/work-items/activity.js';
import { PUBLIC_CHANGE_STATES, PUBLIC_CHANGE_UNKNOWN_REFUSAL } from '@fx/core/src/repos/publicChangeCopy.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { activityResponseSchema } from '../src/routes/work-item-activity.js';
import { seedAccountWithMember } from './helpers/seed.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'v1', 'getWorkItemActivity');
const FX_SESSION_SECRET = 's'.repeat(32);
const SHA = 'a'.repeat(40);
const TIP = 'b'.repeat(40);
// This file's own id namespace (first group), so its fixed ids never meet another test file's on the shared CI database.
const uuid = (block: string, n: number): string => `0598a6a0-0000-4000-8000-${block}${String(n).padStart(11, '0')}`;

interface Seed {
  /** The fixture name: `200-public-change-<name>.json`. */
  name: string;
  state: (typeof PUBLIC_CHANGE_STATES)[number];
  code?: string;
  /** The runtime of the latest push attempt, and how many push attempts the item has. */
  attempts?: { runtime: 'runner' | 'sandbox'; count: number };
  expected: string;
  /** The stored refusal entries, when the row carries them. */
  refusals?: Array<{ kind: string; place: string; rule_key: string }>;
  /** What an owner is offered under the change (P1f-6b): the same predicate the action routes ask. */
  actions?: string[];
}

/** One row per state of the item view, then the refusals that need words of their own. Each is read through the real route and pinned. */
const SEEDS: Seed[] = [
  { name: 'building', state: 'building', expected: 'Building the public change' },
  { name: 'scanning', state: 'scanning', expected: 'Scanning' },
  { name: 'pushed', state: 'pushed', expected: 'Pushed' },
  { name: 'pr_opened', state: 'pr_opened', expected: 'PR opened' },
  { name: 'refused', state: 'refused', code: 'scan_refused', attempts: { runtime: 'sandbox', count: 1 }, expected: 'Refused: the scan found something that must not be public', actions: ['retry_push'] },
  { name: 'pushed_pr_not_opened', state: 'pushed_pr_not_opened', expected: 'Pushed, PR not opened', actions: ['open_pr'] },
  { name: 'no_public_change', state: 'no_public_change', expected: 'No public change' },
  { name: 'refused-retry_limit', state: 'refused', code: 'retry_limit', attempts: { runtime: 'sandbox', count: 3 }, expected: 'Refused: the push has already been tried three times' },
  { name: 'refused-pairing_off', state: 'refused', code: 'pairing_off', attempts: { runtime: 'sandbox', count: 2 }, expected: 'Refused: the pairing is off', actions: ['retry_push'] },
  { name: 'refused-unknown_code', state: 'refused', code: 'a_code_from_the_future', attempts: { runtime: 'sandbox', count: 1 }, expected: PUBLIC_CHANGE_UNKNOWN_REFUSAL, actions: ['retry_push'] },
  { name: 'refused-runner', state: 'refused', code: 'public_unavailable', attempts: { runtime: 'runner', count: 1 }, expected: 'Refused: the public repository could not be reached. Use Build again to try once more.' },
  // D#483 S5-b2c-4: a planned PR child's publish refused with the build identity's code, or by the final text guard
  { name: 'refused-child_orphaned', state: 'refused', code: 'child_orphaned', attempts: { runtime: 'sandbox', count: 1 }, expected: 'Refused: the item this planned PR belonged to was deleted', actions: ['retry_push'] },
  { name: 'refused-parent_closed', state: 'refused', code: 'parent_closed', attempts: { runtime: 'sandbox', count: 1 }, expected: 'Refused: the item this planned PR belongs to is closed', actions: ['retry_push'] },
  { name: 'refused-respec_needs_approval', state: 'refused', code: 'respec_needs_approval', attempts: { runtime: 'sandbox', count: 1 }, expected: 'Refused: the Spec changed and needs approval again', actions: ['retry_push'] },
  { name: 'refused-key_not_in_approved_spec', state: 'refused', code: 'key_not_in_approved_spec', attempts: { runtime: 'sandbox', count: 1 }, expected: 'Refused: this planned PR is no longer in the approved Spec', actions: ['retry_push'] },
  { name: 'refused-no_issue_link', state: 'refused', code: 'no_issue_link', attempts: { runtime: 'sandbox', count: 1 }, expected: 'Refused: the item this planned PR belongs to has no GitHub issue', actions: ['retry_push'] },
  { name: 'refused-not_found', state: 'refused', code: 'not_found', attempts: { runtime: 'sandbox', count: 1 }, expected: 'Refused: the item could not be found', actions: ['retry_push'] },
  { name: 'refused-child_body_closing_keyword', state: 'refused', code: 'child_body_closing_keyword', attempts: { runtime: 'sandbox', count: 1 }, expected: 'Refused: the pull request text would have closed an issue, so nothing was sent', actions: ['retry_push'] },
  { name: 'refused-private_path_change', state: 'refused', code: 'private_path_change', attempts: { runtime: 'runner', count: 1 }, refusals: [{ kind: 'overlay_path', place: 'docs/ops/plan.md', rule_key: 'overlay_path' }], expected: "Refused: the change edits private-only paths (docs/ops/plan.md), which the public repository never receives. Take them out of the Spec's file list and build the change without them, or make that edit in the private repository by hand. The other checks run once the private paths are gone." },
  // A record written before the code existed: every entry is a private-only path, so it reads with the same words.
  { name: 'refused-scan_refused-overlay-only', state: 'refused', code: 'scan_refused', attempts: { runtime: 'runner', count: 1 }, refusals: [{ kind: 'overlay_path', place: 'docs/ops/a.md', rule_key: 'overlay_path' }, { kind: 'overlay_path', place: 'docs/ops/b.md', rule_key: 'overlay_path' }], expected: "Refused: the change edits private-only paths (docs/ops/a.md, docs/ops/b.md), which the public repository never receives. Take them out of the Spec's file list and build the change without them, or make that edit in the private repository by hand. The other checks run once the private paths are gone." },
  // A mix of a private-only path and a real hit stays a scan refusal.
  { name: 'refused-scan_refused-mixed', state: 'refused', code: 'scan_refused', attempts: { runtime: 'sandbox', count: 1 }, refusals: [{ kind: 'overlay_path', place: 'docs/ops/a.md', rule_key: 'overlay_path' }, { kind: 'identifier_hit', place: 'src/a.ts:2', rule_key: 'identifier-rule#1' }], expected: 'Refused: the scan found something that must not be public', actions: ['retry_push'] },
];

/** D#598 P1f-6a against real Postgres: the activity read of every state of a change to a paired public repo, pinned as fixtures. */
describe('public_change through getWorkItemActivity (D#598 P1f-6a)', { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let me: { accountId: string; userId: string };
  let repoId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = FX_SESSION_SECRET;
    me = await seedAccountWithMember(admin, { role: 'owner' });
    repoId = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, settings) VALUES ($1, $2, $3, 'team', 'acme', 'docs', '{}'::jsonb)`, [repoId, me.accountId, Math.floor(Math.random() * 1e9)]);
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  async function getJson(itemId: string): Promise<Record<string, unknown>> {
    const token = await signSession(me);
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${token}` });
    const res = await handleApiRequest(new Request(`http://localhost/api/v1/work-items/${itemId}/activity`, { headers }), appUserPool, platformOpsPool, ROUTES);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  async function seedItem(n: number): Promise<string> {
    const itemId = uuid('1', n);
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number, created_at) VALUES ($1, $2, $3, 'feature', 'internal', 'in_progress', 595, $4)`, [itemId, me.accountId, repoId, new Date('2026-10-03T10:00:00.000Z')]);
    return itemId;
  }

  const pretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
  function pin(name: string, actual: unknown): void {
    const file = path.join(FIXTURES, `200-public-change-${name}.json`);
    if (process.env.FX_WRITE_FIXTURES === '1') {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, pretty(actual));
    }
    expect(existsSync(file), `${file} is missing: run with FX_WRITE_FIXTURES=1 and read the diff`).toBe(true);
    expect(pretty(actual)).toBe(readFileSync(file, 'utf8'));
  }

  SEEDS.forEach((s, i) => {
    it(`${s.name}: the read matches its pinned fixture and the response schema`, async () => {
      const n = i + 1;
      const itemId = await seedItem(n);
      const pushId = uuid('3', n);
      const shaped = ['pushed', 'pr_opened', 'pushed_pr_not_opened'].includes(s.state);
      const pr = s.state === 'pr_opened';
      await admin.query(
        `INSERT INTO plane_pushes (id, account_id, work_item_id, repo_id, code_repo, pairing_digest, head_sha, tip_sha, pr_number, pr_url, state, code, refusals)
         VALUES ($1, $2, $3, $4, 'acme/docs-public', $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
        [pushId, me.accountId, itemId, repoId, 'c'.repeat(64), shaped ? SHA : null, shaped ? TIP : null, pr ? 88 : null, pr ? 'https://github.com/acme/docs-public/pull/88' : null, s.state, s.code ?? null, JSON.stringify(s.refusals ?? [])],
      );
      if (s.attempts) {
        for (let k = 1; k <= s.attempts.count; k++) {
          await admin.query(
            `INSERT INTO plane_push_attempts (account_id, plane_push_id, runtime, lease_generation, kind, attempt_no, outcome, created_at)
             VALUES ($1, $2, $3, $4, 'push', $5, 'refused', $6)`,
            [me.accountId, pushId, s.attempts.runtime, s.attempts.runtime === 'runner' ? 1 : null, k, new Date(Date.parse('2026-10-03T10:00:00.000Z') + k * 1000)],
          );
        }
      }
      const body = await getJson(itemId);
      expect(activityResponseSchema.safeParse(body).success).toBe(true);
      const change = body.public_change as { sentence: string; repo: string; actions: string[] };
      expect(change.sentence).toBe(s.expected);
      expect(change.repo).toBe('acme/docs-public');
      expect(change.actions).toEqual(s.actions ?? []);
      // The item's own list is drawn from the same table, so it names exactly these two when (and only when) the change does.
      const top = (body.actions as string[]).filter((a) => a === 'retry_push' || a === 'open_pr');
      expect(top).toEqual(s.actions ?? []);
      expect(JSON.stringify(change)).not.toMatch(/undefined|NaN/);
      if (s.name === 'refused-unknown_code') expect(JSON.stringify(change.sentence)).not.toContain('a_code_from_the_future');
      pin(s.name, body);
    });
  });

  it('an item with no public change: the core read says null and the API answer has no public_change', async () => {
    const itemId = await seedItem(99);
    const read = await getWorkItemActivity({ pool: appUserPool, principal: { ...me, role: 'owner' } }, itemId);
    expect(read.public_change).toBeNull();
    const body = await getJson(itemId);
    expect(Object.hasOwn(body, 'public_change')).toBe(false);
    expect(activityResponseSchema.safeParse(body).success).toBe(true);
  });

  /** D#598 P1f-5d-ui: the branch cleanup line, read through the real route. `state`/`outcomes` are the row the sweep records; `stage` is where the item sits now. */
  const CLEANUP: Array<[string, string, string, Array<[string, string]>, string | null]> = [
    ['all deleted', 'merged', 'final', [['fx/a', 'deleted'], ['fx/b', 'already_gone']], BRANCH_CLEANUP_SENTENCE.deleted!],
    ['already gone', 'closed', 'final', [['fx/a', 'already_gone']], BRANCH_CLEANUP_SENTENCE.already_gone!],
    ['head differs beats deleted', 'merged', 'final', [['fx/a', 'deleted'], ['fx/b', 'head_changed']], BRANCH_CLEANUP_SENTENCE.head_changed!],
    ['protected', 'closed_unmerged', 'final', [['fx/a', 'protected']], BRANCH_CLEANUP_SENTENCE.protected!],
    ['default branch', 'merged', 'final', [['fx/a', 'default_branch']], BRANCH_CLEANUP_SENTENCE.default_branch!],
    ['no installation', 'merged', 'final', [['fx/a', 'no_installation']], BRANCH_CLEANUP_SENTENCE.no_installation!],
    ['repository gone', 'merged', 'final', [['fx/a', 'repo_gone']], BRANCH_CLEANUP_SENTENCE.repo_gone!],
    ['gave up beats the rest', 'merged', 'final', [['fx/a', 'head_changed'], ['fx/b', 'gave_up']], BRANCH_CLEANUP_SENTENCE.gave_up!],
    ['not final yet', 'merged', 'retrying', [['fx/a', 'deleted']], BRANCH_CLEANUP_SENTENCE.retrying!],
    ['private pull request outcomes alone say nothing', 'merged', 'final', [['pr:7', 'private_pr_closed']], null],
    ['an outcome from the future alone says nothing', 'merged', 'final', [['fx/a', 'a_code_from_the_future']], null],
    ['a reopened item shows nothing', 'in_progress', 'final', [['fx/a', 'deleted']], null],
  ];
  it.each(CLEANUP)('branch_cleanup: %s', async (name, stage, state, outcomes, expected) => {
    const n = 200 + CLEANUP.findIndex((c) => c[0] === name);
    const itemId = await seedItem(n);
    await admin.query(`UPDATE work_items SET stage = $2 WHERE id = $1`, [itemId, stage]);
    const t = await admin.query<{ id: string }>(
      `INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'in_progress', 'merged', now(), 'control_plane', 'x') RETURNING id`,
      [me.accountId, itemId],
    );
    await admin.query(`INSERT INTO branch_cleanups (account_id, work_item_id, transition_id, state, next_attempt_at, outcomes) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`, [
      me.accountId, itemId, t.rows[0]!.id, state, state === 'retrying' ? new Date(Date.now() + 60_000) : null, JSON.stringify(outcomes.map(([branch, outcome]) => ({ branch, outcome }))),
    ]);
    const body = await getJson(itemId);
    expect(activityResponseSchema.safeParse(body).success).toBe(true);
    if (expected === null) expect(Object.hasOwn(body, 'branch_cleanup')).toBe(false);
    else expect(body.branch_cleanup).toEqual({ sentence: expected });
    expect(JSON.stringify(body.branch_cleanup ?? '')).not.toMatch(/null|undefined|_/);
  });
  it('branch_cleanup: a closed item with no cleanup row yet has no line', async () => {
    const itemId = await seedItem(250);
    await admin.query(`UPDATE work_items SET stage = 'merged' WHERE id = $1`, [itemId]);
    expect(Object.hasOwn(await getJson(itemId), 'branch_cleanup')).toBe(false);
  });

  it('private_read_failed: an owner reads the closed class as fixed text after the sentence; a member reads the sentence alone; an unknown stored class shows nothing', async () => {
    const cases: Array<[number, string, string]> = [[101, 'auth_denied', ' The private repository refused the read (access denied).'], [102, 'not_found', ' The private repository did not have the commit.'], [103, 'https://x.example/leak', '']];
    for (const [n, cls, extra] of cases) {
      const itemId = await seedItem(n);
      await admin.query(
        `INSERT INTO plane_pushes (id, account_id, work_item_id, repo_id, code_repo, pairing_digest, state, code, refusals)
         VALUES ($1, $2, $3, $4, 'acme/docs-public', $5, 'refused', 'private_read_failed', $6::jsonb)`,
        [uuid('3', n), me.accountId, itemId, repoId, 'c'.repeat(64), JSON.stringify([{ kind: 'private_read', place: '-', rule_key: cls }])],
      );
      const base = "Refused: the run's commits could not be read from the private repository";
      const body = await getJson(itemId);
      expect((body.public_change as { sentence: string }).sentence).toBe(`${base}${extra}`);
      expect(JSON.stringify(body)).not.toContain('x.example');
      const asMember = await getWorkItemActivity({ pool: appUserPool, principal: { ...me, role: 'member' } }, itemId);
      expect(asMember.public_change?.sentence).toBe(base);
    }
  });
});
