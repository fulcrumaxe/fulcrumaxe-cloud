import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import type { ApplyHooks, GithubWebhookEventName, GithubWebhookPayload } from '../src/eventMapper.js';
import { handleGithubWebhookEventForApp } from '../src/webhookGate.js';
import { loadFixture } from './helpers/fixtures.js';
import { seedAccountWithRepo, seedWorkItem, type SeedRefs } from './helpers/seed.js';

/**
 * D#2 H13e-2 (H2-3, H2-4): against real Postgres, a verified delivery from
 * a non-team App changes nothing, a team delivery for a non-team
 * installation changes nothing, and a team delivery for a team installation
 * still makes its usual writes.
 */
describe('handleGithubWebhookEventForApp (D#2 H13e-2)', () => {
  let adminPool: Pool;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let admin: PoolClient;
  let nextGhInstallationId = 7_000_000;

  // Stands in for the real domain-event emitter: one domain_events row, so pr.opened has a visible write.
  const hooks: ApplyHooks = {
    emitDomainEvent: async (client, event) => {
      await client.query(`INSERT INTO domain_events (account_id, type) VALUES ($1, $2)`, [event.accountId, event.type]);
    },
  };
  const deps = () => ({ appUserPool, platformOpsPool, hooks });

  beforeAll(async () => {
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    appUserPool = createPool(process.env.GITHUB_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.GITHUB_DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
  });

  afterAll(async () => {
    admin.release();
    await appUserPool.end();
    await platformOpsPool.end();
    await adminPool.end();
  });

  async function seed(appKind: string): Promise<SeedRefs> {
    const refs = await seedAccountWithRepo(admin, nextGhInstallationId++);
    await admin.query(`UPDATE installations SET app_kind = $1 WHERE id = $2`, [appKind, refs.installationId]);
    await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: 7, stage: 'in_progress' });
    return refs;
  }

  /** Every table a delivery can write for this account, as one comparable string. */
  async function snapshot(refs: SeedRefs): Promise<string> {
    const { rows } = await admin.query(
      `SELECT
         (SELECT count(*) FROM work_items WHERE account_id = $1) AS work_items,
         (SELECT count(*) FROM work_item_transitions WHERE account_id = $1) AS transitions,
         (SELECT count(*) FROM domain_events WHERE account_id = $1) AS domain_events,
         (SELECT count(*) FROM run_events WHERE account_id = $1) AS run_events,
         (SELECT count(*) FROM agent_runs WHERE account_id = $1) AS agent_runs,
         (SELECT count(*) FROM installations WHERE account_id = $1) AS installations,
         (SELECT count(*) FROM repos WHERE account_id = $1) AS repos,
         (SELECT string_agg(coalesce(gh_owner, '-') || '/' || coalesce(gh_name, '-'), ',' ORDER BY id) FROM repos WHERE account_id = $1) AS names`,
      [refs.accountId],
    );
    return JSON.stringify(rows[0]);
  }

  const FIXTURES: Array<[GithubWebhookEventName, string]> = [
    ['pull_request', 'pull_request.opened.json'],
    ['issues', 'issue.opened.trusted.json'],
    ['issue_comment', 'issue_comment.created.json'],
    ['discussion_comment', 'discussion_comment.created.json'],
    ['installation', 'installation.created.with-repos.json'],
  ];

  function payloadFor(fixture: string, refs: SeedRefs): GithubWebhookPayload {
    const payload = loadFixture<Record<string, unknown>>(fixture);
    (payload.installation as { id: number }).id = refs.ghInstallationId;
    return payload as unknown as GithubWebhookPayload;
  }

  for (const sender of ['team_readonly', 'sitekit'] as const) {
    describe(`a verified ${sender} delivery is inert (H2-3)`, () => {
      for (const [eventName, fixture] of FIXTURES) {
        it(`${eventName}: acknowledged, no row changes, even for a tracked team installation`, async () => {
          const refs = await seed('team');
          const before = await snapshot(refs);
          const result = await handleGithubWebhookEventForApp(deps(), eventName, payloadFor(fixture, refs), `d-${randomUUID()}`, sender);
          expect(result).toEqual({ handled: false, reason: 'inert_app_kind' });
          expect(await snapshot(refs)).toBe(before);
        });
      }

      it('is inert without reaching the database at all', async () => {
        const never = {
          connect: () => {
            throw new Error('the database must not be reached');
          },
        } as unknown as Pool;
        const refs = await seed('team');
        const result = await handleGithubWebhookEventForApp(
          { appUserPool: never, platformOpsPool: never },
          'pull_request',
          payloadFor('pull_request.opened.json', refs),
          'd1',
          sender,
        );
        expect(result).toMatchObject({ handled: false });
      });
    });
  }

  describe('positive control: a team delivery for a team installation still writes', () => {
    for (const [eventName, fixture] of FIXTURES.filter(([name]) => ['pull_request', 'issues', 'installation'].includes(name))) {
      it(`${eventName} changes rows`, async () => {
        const refs = await seed('team');
        const before = await snapshot(refs);
        const payload = payloadFor(fixture, refs) as unknown as { issue?: { number: number } };
        if (payload.issue) payload.issue.number = 950;
        const result = await handleGithubWebhookEventForApp(deps(), eventName, payload as unknown as GithubWebhookPayload, `d-${randomUUID()}`, 'team');
        expect(result.handled).toBe(true);
        expect(await snapshot(refs)).not.toBe(before);
      });
    }
  });

  describe('kind cross-check (H2-4)', () => {
    for (const rowKind of ['team_readonly', 'sitekit'] as const) {
      for (const [eventName, fixture] of FIXTURES) {
        it(`a team delivery for a ${rowKind} installation is inert: ${eventName}`, async () => {
          const refs = await seed(rowKind);
          const before = await snapshot(refs);
          const warn = vi.fn();
          const result = await handleGithubWebhookEventForApp(deps(), eventName, payloadFor(fixture, refs), `d-${randomUUID()}`, 'team', {
            warn,
          });
          expect(result).toEqual({ handled: false, reason: 'app_kind_mismatch' });
          expect(await snapshot(refs)).toBe(before);
          // Exactly one line, carrying the installation id and nothing else.
          expect(warn).toHaveBeenCalledTimes(1);
          expect(warn).toHaveBeenCalledWith(`github webhook: app kind mismatch for installation ${refs.ghInstallationId}`);
        });
      }
    }

    it('an installation id with no row is processed as before (no warning)', async () => {
      const warn = vi.fn();
      const refs = await seed('team');
      const payload = payloadFor('issue.opened.trusted.json', refs) as unknown as { installation: { id: number } };
      payload.installation.id = 999_999_991;
      const result = await handleGithubWebhookEventForApp(deps(), 'issues', payload as unknown as GithubWebhookPayload, 'd1', 'team', { warn });
      expect(result).toEqual({ handled: false, reason: 'unknown_tenant' });
      expect(warn).not.toHaveBeenCalled();
    });

    it('a delivery with no installation field is processed as before (no cross-check, no warning)', async () => {
      const warn = vi.fn();
      const refs = await seed('team');
      const payload = payloadFor('issue.opened.trusted.json', refs) as unknown as Record<string, unknown>;
      delete payload.installation;
      const result = await handleGithubWebhookEventForApp(deps(), 'issues', payload as unknown as GithubWebhookPayload, 'd1', 'team', { warn });
      expect(result).toEqual({ handled: false, reason: 'unknown_tenant' });
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
