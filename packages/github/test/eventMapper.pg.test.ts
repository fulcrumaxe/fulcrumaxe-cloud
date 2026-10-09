import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { recordStage } from '@fx/core/src/work-items/recordStage.js';
import {
  applyMappedEvent,
  handleGithubWebhookEvent,
  mapEvent,
  type ApplyEventCtx,
  type ApplyHooks,
  type ApplyResult,
  type DomainEvent,
  type GithubInstallationPayload,
  type GithubIssuePayload,
  type GithubPullRequestPayload,
  type GithubPushPayload,
  type MappedEvent,
} from '../src/eventMapper.js';
import { loadFixture } from './helpers/fixtures.js';
import { seedAccountWithRepo, seedWorkItem, type SeedRefs } from './helpers/seed.js';

/**
 * D#2 H13a: real-Postgres integration for C18 (recordStage, deduped by
 * delivery id), C7 (the pr.opened emitDomainEvent hook point, pinned by a
 * spy per C26 section 3 -- "the part writeRunStatus did not have"), and
 * C25 item 2 (the .mcp.json push hook point, also pinned by a spy).
 * eventMapper.test.ts covers the pure mapping layer with no database.
 */
const mapMappedFor = (payload: GithubPullRequestPayload): MappedEvent => mapEvent('pull_request', payload, { allowlist: [] });

describe('applyMappedEvent (D#2 H13a, C18 + C7 + C25)', () => {
  let adminPool: Pool;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let admin: PoolClient;
  let refs: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    appUserPool = createPool(process.env.GITHUB_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.GITHUB_DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
    refs = await seedAccountWithRepo(admin, 4242);
  });

  afterAll(async () => {
    admin.release();
    await appUserPool.end();
    await platformOpsPool.end();
    await adminPool.end();
  });

  function repo() {
    return { accountId: refs.accountId, repoId: refs.repoId, ghRepoId: refs.ghRepoId, fullName: refs.repoFullName };
  }

  /** withTenant + applyMappedEvent, with the boilerplate ctx fields filled in. */
  function apply(mapped: MappedEvent, opts: { deliveryId?: string; hooks?: ApplyHooks } = {}): Promise<ApplyResult> {
    const ctx: ApplyEventCtx = {
      accountId: refs.accountId,
      installationId: refs.installationId,
      repoId: refs.repoId,
      repo: repo(),
      deliveryId: opts.deliveryId ?? `d-${randomUUID()}`,
      hooks: opts.hooks,
    };
    return withTenant(appUserPool, refs.accountId, (client) => applyMappedEvent(client, ctx, mapped));
  }

  describe('D#6 R5b-2a: pull_request.synchronize records the push of a head commit (it starts the quiet period of a cloud-verified review)', () => {
    type Sync = GithubPullRequestPayload & { after: string; repository: Record<string, unknown> };
    const synchronize = (body: string | null): Sync => {
      const real = loadFixture<Sync>('pull_request.synchronize.json');
      return { ...real, pull_request: { ...real.pull_request, body } };
    };
    const pushes = async (workItemId: string) =>
      (await admin.query(`SELECT head_sha, pr_number, code, created_at FROM work_item_driver_events WHERE account_id = $1 AND work_item_id = $2 AND kind = 'pr_head_pushed'`, [refs.accountId, workItemId])).rows;

    it('writes one fact per head commit, stamped by the database clock; a redelivery writes nothing and moves no time', async () => {
      const workItemId = await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: 139, stage: 'pr_opened' });
      const payload = synchronize('Closes #139');
      const mapped = mapEvent('pull_request', payload, { allowlist: [] });
      const deliveryId = `d-${randomUUID()}`;
      expect(await apply(mapped, { deliveryId })).toMatchObject({ applied: 'pr_push_recorded', workItemId, recorded: true });
      const first = await pushes(workItemId);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ head_sha: payload.after, pr_number: 139, code: 'synchronize' });
      expect(Math.abs(Date.now() - new Date(first[0].created_at).getTime())).toBeLessThan(60_000);

      expect(await apply(mapped, { deliveryId })).toMatchObject({ applied: 'pr_push_recorded', workItemId, recorded: false });
      const again = await pushes(workItemId);
      expect(again).toHaveLength(1);
      expect(new Date(again[0].created_at).getTime()).toBe(new Date(first[0].created_at).getTime());
    });

    it('a push back to a head seen before (A, B, A) is a new fact each time: the delivery decides, not the head', async () => {
      const workItemId = await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: 1392, stage: 'pr_opened' });
      const base = synchronize('Closes #1392');
      const at = (sha: string) => mapEvent('pull_request', { ...base, pull_request: { ...base.pull_request, head: { ...base.pull_request.head, sha } } }, { allowlist: [] });
      const A = 'a'.repeat(40);
      const B = 'b'.repeat(40);
      await apply(at(A));
      await apply(at(B));
      expect(await apply(at(A))).toMatchObject({ applied: 'pr_push_recorded', recorded: true });
      expect((await pushes(workItemId)).map((r) => r.head_sha)).toEqual([A, B, A]);
    });

    it('a fork from an untrusted author, a pull request naming no issue, and one naming an issue with no work item record nothing', async () => {
      const workItemId = await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: 1390, stage: 'pr_opened' });
      const real = synchronize('Closes #1390');
      const fork = { ...real, pull_request: { ...real.pull_request, author_association: 'NONE', user: { login: 'stranger' }, head: { ...real.pull_request.head, repo: { id: 1 } } } };
      expect(await apply(mapEvent('pull_request', fork, { allowlist: [] }))).toMatchObject({ applied: 'skipped' });
      expect(await apply(mapEvent('pull_request', synchronize(null), { allowlist: [] }))).toMatchObject({ applied: 'skipped' });
      expect(await apply(mapEvent('pull_request', synchronize('Closes #987654'), { allowlist: [] }))).toMatchObject({ applied: 'skipped' });
      expect(await pushes(workItemId)).toEqual([]);
    });

    it('arrives through the whole webhook path (tenant resolved from the delivery) and lands on the item the body links', async () => {
      const workItemId = await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: 1391, stage: 'pr_opened' });
      const real = synchronize('Closes #1391');
      const payload = { ...real, installation: { id: refs.ghInstallationId }, repository: { ...real.repository, id: refs.ghRepoId } };
      const out = await handleGithubWebhookEvent({ appUserPool, platformOpsPool, allowlist: [] }, 'pull_request', payload as never, `d-${randomUUID()}`);
      expect(out).toMatchObject({ handled: true, result: { applied: 'pr_push_recorded', workItemId, recorded: true } });
      expect(await pushes(workItemId)).toHaveLength(1);
    });
  });

  describe('C18: pull_request.opened calls recordStage, deduped by X-GitHub-Delivery', () => {
    it('produces exactly one work_item_transitions row with to_stage=pr_opened, source=webhook, at = payload.pull_request.created_at; a redelivery adds no row', async () => {
      const workItemId = await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: 7, stage: 'in_progress' });
      const payload = loadFixture<GithubPullRequestPayload>('pull_request.opened.json');
      const mapped = mapEvent('pull_request', payload, { allowlist: [] });
      const deliveryId = `delivery-${randomUUID()}`;

      const first = await apply(mapped, { deliveryId });
      expect(first).toMatchObject({ applied: 'transitioned', workItemId, recorded: true });

      const { rows } = await admin.query(
        `SELECT to_stage, source, source_ref, at FROM work_item_transitions WHERE account_id = $1 AND work_item_id = $2`,
        [refs.accountId, workItemId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].to_stage).toBe('pr_opened');
      expect(rows[0].source).toBe('webhook');
      expect(rows[0].source_ref).toBe(deliveryId);
      expect(new Date(rows[0].at).toISOString()).toBe('2026-09-24T12:00:00.000Z');

      // Redelivery: same X-GitHub-Delivery id -> recordStage returns
      // recorded:false, H13a treats it as success, no second row appears.
      const redelivered = await apply(mapped, { deliveryId });
      expect(redelivered).toMatchObject({ applied: 'transitioned', workItemId, recorded: false });

      const { rows: afterReplay } = await admin.query(
        `SELECT id FROM work_item_transitions WHERE account_id = $1 AND work_item_id = $2 AND to_stage = 'pr_opened'`,
        [refs.accountId, workItemId],
      );
      expect(afterReplay).toHaveLength(1);
    });

    it('a late pull_request.opened after the stage driver already moved the item to pr_opened (Check the build) is an idempotent no-op: 2xx-shaped result, stage unchanged, transaction still usable', async () => {
      const payload = loadFixture<GithubPullRequestPayload>('pull_request.opened.json');
      for (const stage of ['pr_opened', 'changes_requested', 'review_passed']) {
        const gh = stage === 'pr_opened' ? 712 : stage === 'changes_requested' ? 713 : 714;
        payload.pull_request.body = `Closes #${gh}`;
        const workItemId = await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: gh, stage: 'in_progress' });
        // The driver's own record, as advancePrFound writes it.
        await withTenant(appUserPool, refs.accountId, async (client) => {
          await recordStage(client, { workItemId, toStage: 'pr_opened', at: new Date(), source: 'control_plane', sourceRef: 'pr_found:41' });
          if (stage !== 'pr_opened') {
            await recordStage(client, { workItemId, toStage: stage as 'changes_requested', reviewer: 'code', at: new Date(), source: 'control_plane', sourceRef: `later-${stage}` });
          }
        });
        const events: string[] = [];
        const result = await withTenant(appUserPool, refs.accountId, async (client) => {
          const r = await applyMappedEvent(
            client,
            { accountId: refs.accountId, installationId: refs.installationId, repoId: refs.repoId, repo: repo(), deliveryId: `late-${randomUUID()}`, hooks: { emitDomainEvent: async (_c, e) => void events.push(e.type) } },
            mapMappedFor(payload),
          );
          // The transaction is intact: a statement after the skipped transition still runs.
          const after = await client.query('SELECT stage FROM work_items WHERE id = $1', [workItemId]);
          return { r, stage: after.rows[0].stage as string };
        });
        expect(result.r).toMatchObject({ applied: 'transitioned', workItemId, recorded: false });
        expect(result.stage).toBe(stage);
        expect(events).toEqual([]); // no second pr.opened event
        const { rows } = await admin.query(`SELECT to_stage FROM work_item_transitions WHERE work_item_id = $1 AND source = 'webhook'`, [workItemId]);
        expect(rows).toEqual([]);
      }
    });

    it('pull_request.closed + merged:true records a merged transition; merged:false records closed_unmerged', async () => {
      const mergedItemId = await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: 70, stage: 'pr_opened' });
      const unmergedItemId = await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: 71, stage: 'pr_opened' });

      const mergedPayload = loadFixture<GithubPullRequestPayload>('pull_request.closed.merged.json');
      mergedPayload.pull_request.body = 'Closes #70';
      const unmergedPayload = loadFixture<GithubPullRequestPayload>('pull_request.closed.unmerged.json');
      unmergedPayload.pull_request.body = 'Closes #71';

      await apply(mapEvent('pull_request', mergedPayload, { allowlist: [] }));
      await apply(mapEvent('pull_request', unmergedPayload, { allowlist: [] }));

      const { rows: mergedRows } = await admin.query(
        `SELECT to_stage FROM work_item_transitions WHERE account_id = $1 AND work_item_id = $2`,
        [refs.accountId, mergedItemId],
      );
      expect(mergedRows.map((r: { to_stage: string }) => r.to_stage)).toEqual(['merged']);

      const { rows: unmergedRows } = await admin.query(
        `SELECT to_stage FROM work_item_transitions WHERE account_id = $1 AND work_item_id = $2`,
        [refs.accountId, unmergedItemId],
      );
      expect(unmergedRows.map((r: { to_stage: string }) => r.to_stage)).toEqual(['closed_unmerged']);
    });

    it('an unlinked PR (no Closes/Fixes/Resolves match, or no matching work item) is a safe no-op -- never throws, never writes', async () => {
      const payload = loadFixture<GithubPullRequestPayload>('pull_request.opened.no-link.json');
      const result = await apply(mapEvent('pull_request', payload, { allowlist: [] }));
      expect(result.applied).toBe('skipped');
    });
  });

  describe('C7: the pr.opened emitDomainEvent hook point, pinned by a spy', () => {
    it('calls the spy exactly once, with the SAME client recordStage received, only when recordStage returned recorded:true, with only id/enum payload fields; a redelivery makes zero additional calls', async () => {
      const workItemId = await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: 700, stage: 'in_progress' });
      const payload = loadFixture<GithubPullRequestPayload>('pull_request.opened.json');
      payload.pull_request.body = 'Closes #700';
      const mapped = mapEvent('pull_request', payload, { allowlist: [] });

      const emitDomainEvent = vi.fn(async (_client: PoolClient, _event: DomainEvent) => {});
      const deliveryId = `d-${randomUUID()}`;
      let clientSeenByApply: PoolClient | undefined;

      await withTenant(appUserPool, refs.accountId, async (client) => {
        clientSeenByApply = client;
        return applyMappedEvent(
          client,
          { accountId: refs.accountId, installationId: refs.installationId, repoId: refs.repoId, repo: repo(), deliveryId, hooks: { emitDomainEvent } },
          mapped,
        );
      });

      expect(emitDomainEvent).toHaveBeenCalledTimes(1);
      const [calledWithClient, calledWithEvent] = emitDomainEvent.mock.calls[0]!;
      expect(calledWithClient).toBe(clientSeenByApply);
      expect(calledWithEvent.type).toBe('pr.opened');
      expect(calledWithEvent.accountId).toBe(refs.accountId);
      expect(Object.keys(calledWithEvent.payload).sort()).toEqual(['prNumber', 'prUrl', 'repoFullName', 'stage', 'workItemId'].sort());
      expect(calledWithEvent.payload.workItemId).toBe(workItemId);
      expect(calledWithEvent.payload.stage).toBe('pr_opened');

      await apply(mapped, { deliveryId, hooks: { emitDomainEvent } });
      expect(emitDomainEvent).toHaveBeenCalledTimes(1);
    });

    it('a pull_request.closed event never calls the pr.opened hook', async () => {
      await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: 701, stage: 'pr_opened' });
      const payload = loadFixture<GithubPullRequestPayload>('pull_request.closed.merged.json');
      payload.pull_request.body = 'Closes #701';
      const emitDomainEvent = vi.fn(async () => {});
      await apply(mapEvent('pull_request', payload, { allowlist: [] }), { hooks: { emitDomainEvent } });
      expect(emitDomainEvent).not.toHaveBeenCalled();
    });
  });

  describe('D#31 API-4a comment 18587796: the REAL emitDomainEvent wired into this hook point', () => {
    it('one domain_events row is written per pull_request.opened delivery, in the same transaction as the transition', async () => {
      // The real outbox writer (packages/core/src/domain-events/emit.ts),
      // not a spy -- this is what apps/web/app/api/github/webhook/handler.ts's
      // defaultGithubWebhookDeps() now registers as the ONE real-wiring
      // call site (this package itself already depends on @fx/core for
      // recordStage.js, so this is not a new cross-package dependency).
      const { emitDomainEvent: realEmitDomainEvent } = await import('@fx/core/src/domain-events/emit.js');
      // Adapter: the real function returns Promise<EmittedDomainEvent>,
      // which TypeScript does not accept where ApplyHooks's
      // `EmitDomainEvent` (Promise<void>) is expected -- see
      // apps/web/app/api/github/webhook/handler.ts's identical adapter.
      const emitDomainEvent = async (client: PoolClient, event: DomainEvent): Promise<void> => {
        await realEmitDomainEvent(client, event);
      };

      const workItemId = await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: 702, stage: 'in_progress' });
      const payload = loadFixture<GithubPullRequestPayload>('pull_request.opened.json');
      payload.pull_request.body = 'Closes #702';
      const mapped = mapEvent('pull_request', payload, { allowlist: [] });
      const deliveryId = `d-${randomUUID()}`;

      const result = await apply(mapped, { deliveryId, hooks: { emitDomainEvent } });
      expect(result).toMatchObject({ applied: 'transitioned', workItemId, recorded: true });

      const { rows } = await admin.query(
        `SELECT type, account_id, payload FROM domain_events WHERE account_id = $1 AND type = 'pr.opened' AND payload ->> 'workItemId' = $2`,
        [refs.accountId, workItemId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].account_id).toBe(refs.accountId);
      expect(rows[0].payload.stage).toBe('pr_opened');

      // A redelivery (recordStage returns recorded:false) makes zero
      // additional emitDomainEvent calls, so zero additional rows.
      await apply(mapped, { deliveryId, hooks: { emitDomainEvent } });
      const { rows: afterReplay } = await admin.query(
        `SELECT id FROM domain_events WHERE account_id = $1 AND type = 'pr.opened' AND payload ->> 'workItemId' = $2`,
        [refs.accountId, workItemId],
      );
      expect(afterReplay).toHaveLength(1);
    });
  });

  describe('C25 item 2: the .mcp.json push hook point, pinned by a spy', () => {
    it('a default-branch push touching .mcp.json calls the hook exactly once, with the RepoRef', async () => {
      const payload = loadFixture<GithubPushPayload>('push.default-branch-mcp.json');
      const mapped = mapEvent('push', payload, { allowlist: [] });
      expect(mapped.kind).toBe('route_mcp_config');

      const syncDefaultBranchMcpConfig = vi.fn(async () => {});
      const result = await apply(mapped, { hooks: { syncDefaultBranchMcpConfig } });
      expect(result.applied).toBe('mcp_config_routed');
      expect(syncDefaultBranchMcpConfig).toHaveBeenCalledTimes(1);
      expect(syncDefaultBranchMcpConfig).toHaveBeenCalledWith(repo());
    });

    it.each([
      ['push.default-branch-no-mcp.json', 'push'],
      ['push.other-branch-mcp.json', 'push'],
    ] as const)('%s never calls the hook', async (fixtureName, eventName) => {
      const payload = loadFixture<GithubPushPayload>(fixtureName);
      const syncDefaultBranchMcpConfig = vi.fn(async () => {});
      await apply(mapEvent(eventName, payload, { allowlist: [] }), { hooks: { syncDefaultBranchMcpConfig } });
      expect(syncDefaultBranchMcpConfig).not.toHaveBeenCalled();
    });

    it('a pull_request event never calls the mcp config hook', async () => {
      const payload = loadFixture<GithubPullRequestPayload>('pull_request.opened.no-link.json');
      const syncDefaultBranchMcpConfig = vi.fn(async () => {});
      await apply(mapEvent('pull_request', payload, { allowlist: [] }), { hooks: { syncDefaultBranchMcpConfig } });
      expect(syncDefaultBranchMcpConfig).not.toHaveBeenCalled();
    });
  });

  describe('D#2 H13c (C27, H13c-3): installation.created writes repos.gh_owner/gh_name', () => {
    it('writes owner/name for repos already tracked for this account, skips ones that are not, and is idempotent on redelivery', async () => {
      const payload = loadFixture<GithubInstallationPayload>('installation.created.with-repos.json');
      const mapped = mapEvent('installation', payload, { allowlist: [] });
      expect(mapped.kind).toBe('write_repo_names');

      const first = await apply(mapped);
      // refs.ghRepoId (9001, "widgets") is the only one of the fixture's
      // two repos (9001, 9002) seeded for this account -- 9002 matches no
      // row and is silently skipped, same "safe no-op" shape as an
      // unlinked PR.
      expect(first).toMatchObject({ applied: 'repo_names_written', count: 1 });

      const { rows } = await admin.query(`SELECT gh_owner, gh_name FROM repos WHERE account_id = $1 AND id = $2`, [
        refs.accountId,
        refs.repoId,
      ]);
      expect(rows[0]).toEqual({ gh_owner: 'acme-corp', gh_name: 'widgets' });

      // Redelivery: same payload, same result, no error -- "writes
      // nothing new" because it is the same UPDATE, not a second INSERT.
      const second = await apply(mapped);
      expect(second).toMatchObject({ applied: 'repo_names_written', count: 1 });
      const { rows: afterReplay } = await admin.query(`SELECT gh_owner, gh_name FROM repos WHERE account_id = $1 AND id = $2`, [
        refs.accountId,
        refs.repoId,
      ]);
      expect(afterReplay[0]).toEqual({ gh_owner: 'acme-corp', gh_name: 'widgets' });
    });

    it('a repo belonging to a DIFFERENT account with the same gh_repo_id is never touched (account_id-scoped UPDATE)', async () => {
      const other = await seedAccountWithRepo(admin, 4343);
      const payload = loadFixture<GithubInstallationPayload>('installation.created.with-repos.json');
      const mapped = mapEvent('installation', payload, { allowlist: [] });

      await apply(mapped);

      const { rows } = await admin.query(`SELECT gh_owner, gh_name FROM repos WHERE account_id = $1 AND id = $2`, [
        other.accountId,
        other.repoId,
      ]);
      expect(rows[0]).toEqual({ gh_owner: null, gh_name: null });
    });

    it('S2 (fix round 1, D#2 C27): a repo belonging to the SAME account but a DIFFERENT installation is never touched (installation-scoped UPDATE)', async () => {
      const acct = await seedAccountWithRepo(admin, 909_090 + Math.floor(Math.random() * 90_000));

      // A second installation under the SAME account -- two GitHub App
      // installations under one fulcrumaxe account -- with a repo that
      // happens to share the fixture's gh_repo_id (9001).
      const otherInstallationId = randomUUID();
      await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')`, [
        otherInstallationId,
        acct.accountId,
        909_190 + Math.floor(Math.random() * 90_000),
      ]);
      const otherRepoId = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, 'team')`, [
        otherRepoId,
        acct.accountId,
        otherInstallationId,
        acct.ghRepoId,
      ]);

      const payload = loadFixture<GithubInstallationPayload>('installation.created.with-repos.json');
      const mapped = mapEvent('installation', payload, { allowlist: [] });
      expect(mapped.kind).toBe('write_repo_names');

      // Delivered as `acct`'s ORIGINAL installation (acct.installationId),
      // not the second one -- ctx pinned to the delivering installation.
      const ctx: ApplyEventCtx = {
        accountId: acct.accountId,
        installationId: acct.installationId,
        repoId: acct.repoId,
        repo: { accountId: acct.accountId, repoId: acct.repoId, ghRepoId: acct.ghRepoId, fullName: acct.repoFullName },
        deliveryId: `d-${randomUUID()}`,
      };
      const result = await withTenant(appUserPool, acct.accountId, (client) => applyMappedEvent(client, ctx, mapped));
      expect(result).toMatchObject({ applied: 'repo_names_written', count: 1 });

      const { rows: written } = await admin.query(`SELECT gh_owner, gh_name FROM repos WHERE id = $1`, [acct.repoId]);
      expect(written[0]).toEqual({ gh_owner: 'acme-corp', gh_name: 'widgets' });

      const { rows: untouched } = await admin.query(`SELECT gh_owner, gh_name FROM repos WHERE id = $1`, [otherRepoId]);
      expect(untouched[0]).toEqual({ gh_owner: null, gh_name: null });
    });
  });

  describe('body criterion 2: issue/discussion creation is the first real writer of work_items (D#123 item 1 context)', () => {
    it('a trusted issue.opened event inserts a work_items row with provenance=internal', async () => {
      const payload = loadFixture<GithubIssuePayload>('issue.opened.trusted.json');
      payload.issue.number = 900;
      const mapped = mapEvent('issues', payload, { allowlist: [] });
      expect(mapped.kind).toBe('create_work_item');

      const result = await apply(mapped);
      expect(result.applied).toBe('created');

      // gh_number is bigint; node-postgres returns bigint columns as
      // strings, so the read-back cast to ::int is this test's own
      // concern, not applyMappedEvent's INSERT (already binds gh_number
      // as a JS number against the bigint column correctly).
      const { rows } = await admin.query(
        `SELECT provenance, kind, gh_number::int AS gh_number, stage FROM work_items WHERE account_id = $1 AND id = $2`,
        [refs.accountId, (result as { workItemId: string }).workItemId],
      );
      expect(rows[0]).toMatchObject({ provenance: 'internal', kind: 'issue', gh_number: 900, stage: 'triaged' });
    });

    it('redelivery of the same issue.opened event is idempotent (no duplicate row)', async () => {
      const payload = loadFixture<GithubIssuePayload>('issue.opened.trusted.json');
      payload.issue.number = 901;
      const mapped = mapEvent('issues', payload, { allowlist: [] });

      const first = await apply(mapped);
      const second = await apply(mapped);
      expect((first as { workItemId: string }).workItemId).toBe((second as { workItemId: string }).workItemId);

      const { rows } = await admin.query(
        `SELECT count(*)::int AS n FROM work_items WHERE account_id = $1 AND kind = 'issue' AND gh_number = 901`,
        [refs.accountId],
      );
      expect(rows[0].n).toBe(1);
    });
  });

  describe('handleGithubWebhookEvent: tenant resolution end to end', () => {
    it('resolves gh_installation_id/gh_repo_id to account_id/repo_id and applies the mapped event', async () => {
      const payload = loadFixture<GithubIssuePayload>('issue.opened.trusted.json');
      payload.issue.number = 950;
      const result = await handleGithubWebhookEvent({ appUserPool, platformOpsPool }, 'issues', payload, `d-${randomUUID()}`);
      expect(result.handled).toBe(true);
      if (result.handled) {
        expect(result.result.applied).toBe('created');
      }
    });

    it('an unknown installation id is acknowledged as handled:false, never throws', async () => {
      const payload = loadFixture<GithubIssuePayload>('issue.opened.trusted.json');
      const withUnknownInstallation = { ...payload, installation: { id: 999999999 } };
      const result = await handleGithubWebhookEvent(
        { appUserPool, platformOpsPool },
        'issues',
        withUnknownInstallation,
        `d-${randomUUID()}`,
      );
      expect(result).toEqual({ handled: false, reason: 'unknown_tenant' });
    });

    it('CWE-639/706: an installation id shared by two accounts resolves to handled:false, no work item in either tenant', async () => {
      const dupGhInstallationId = 999;
      // seedAccountWithRepo hardcodes gh_repo_id=9001 for every account, so
      // these two accounts share BOTH the installation and repo id -- the
      // ambiguous-row shape resolveTenant must refuse, not guess through.
      const a = await seedAccountWithRepo(admin, dupGhInstallationId);
      const b = await seedAccountWithRepo(admin, dupGhInstallationId, 'team_readonly');

      const payload = loadFixture<GithubIssuePayload>('issue.opened.trusted.json');
      payload.issue.number = 960;
      const withDupInstallation = { ...payload, installation: { id: dupGhInstallationId }, repository: { id: a.ghRepoId, full_name: a.repoFullName, default_branch: a.defaultBranch } };

      const result = await handleGithubWebhookEvent({ appUserPool, platformOpsPool }, 'issues', withDupInstallation, `d-${randomUUID()}`);
      expect(result).toEqual({ handled: false, reason: 'unknown_tenant' });

      const { rows } = await admin.query(`SELECT count(*)::int AS n FROM work_items WHERE account_id IN ($1, $2) AND gh_number = 960`, [a.accountId, b.accountId]);
      expect(rows[0].n).toBe(0);
    });
  });

  describe('CWE-863: fork or untrusted-author PRs never transition stage', () => {
    it('a fork PR from an untrusted author (association NONE) is skipped, no transition row, stage unchanged', async () => {
      const workItemId = await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: 800, stage: 'in_progress' });
      const payload = loadFixture<GithubPullRequestPayload>('pull_request.opened.fork.json');

      const result = await handleGithubWebhookEvent({ appUserPool, platformOpsPool }, 'pull_request', payload, `d-${randomUUID()}`);
      expect(result.handled).toBe(true);
      if (result.handled) expect(result.result).toMatchObject({ applied: 'skipped' });

      const { rows: itemRows } = await admin.query(`SELECT stage FROM work_items WHERE account_id = $1 AND id = $2`, [refs.accountId, workItemId]);
      expect(itemRows[0].stage).toBe('in_progress');
      const { rows: transitionRows } = await admin.query(
        `SELECT id FROM work_item_transitions WHERE account_id = $1 AND work_item_id = $2`,
        [refs.accountId, workItemId],
      );
      expect(transitionRows).toHaveLength(0);
    });

    it('a PR with head.repo: null is also skipped, no transition row', async () => {
      const workItemId = await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: 801, stage: 'in_progress' });
      const payload = loadFixture<GithubPullRequestPayload>('pull_request.opened.fork-null-head.json');

      const result = await handleGithubWebhookEvent({ appUserPool, platformOpsPool }, 'pull_request', payload, `d-${randomUUID()}`);
      expect(result.handled).toBe(true);
      if (result.handled) expect(result.result).toMatchObject({ applied: 'skipped' });

      const { rows: transitionRows } = await admin.query(
        `SELECT id FROM work_item_transitions WHERE account_id = $1 AND work_item_id = $2`,
        [refs.accountId, workItemId],
      );
      expect(transitionRows).toHaveLength(0);
    });
  });

  describe('D#483 P1: a PR that closes an issue finds the pipeline root, not the retired webhook row', () => {
    const prFor = (n: number) => {
      const payload = loadFixture<GithubPullRequestPayload>('pull_request.opened.json');
      payload.pull_request.body = `Fixes the thing.\n\nCloses #${n}`;
      return payload;
    };
    const stageOf = async (id: string) => (await admin.query(`SELECT stage FROM work_items WHERE id = $1`, [id])).rows[0].stage as string;

    it("moves the root (kind 'feature', not 'issue') to pr_opened and leaves the superseded closed row alone, with no error", async () => {
      const webhookRow = await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: 1200, stage: 'closed' });
      const root = await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: 1200, kind: 'feature', stage: 'in_progress' });
      const result = await handleGithubWebhookEvent({ appUserPool, platformOpsPool }, 'pull_request', prFor(1200), `d-${randomUUID()}`);
      expect(result).toMatchObject({ handled: true, result: { applied: 'transitioned', workItemId: root, recorded: true } });
      expect(await stageOf(root)).toBe('pr_opened');
      expect(await stageOf(webhookRow)).toBe('closed');
      const t = await admin.query(`SELECT count(*)::int AS n FROM work_item_transitions WHERE work_item_id = $1`, [webhookRow]);
      expect(t.rows[0].n).toBe(0);
    });

    it('prefers the open item whichever row is older or newer; with only a closed row it picks that row (the stage machine then refuses it, as for any closed item)', async () => {
      const root = await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: 1201, kind: 'bug', stage: 'in_progress' });
      // The retired row is NEWER than the root: the open one must still win.
      const retired = await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: 1201, stage: 'closed' });
      await admin.query(`UPDATE work_items SET created_at = now() + interval '1 hour' WHERE id = $1`, [retired]);
      const result = await handleGithubWebhookEvent({ appUserPool, platformOpsPool }, 'pull_request', prFor(1201), `d-${randomUUID()}`);
      expect(result).toMatchObject({ handled: true, result: { applied: 'transitioned', workItemId: root } });
    });

    it('two open items with the same number: the newest wins', async () => {
      const older = await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: 1202, stage: 'in_progress' });
      const newer = await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: 1202, kind: 'feature', stage: 'in_progress' });
      await admin.query(`UPDATE work_items SET created_at = now() - interval '1 hour' WHERE id = $1`, [older]);
      const result = await handleGithubWebhookEvent({ appUserPool, platformOpsPool }, 'pull_request', prFor(1202), `d-${randomUUID()}`);
      expect(result).toMatchObject({ handled: true, result: { applied: 'transitioned', workItemId: newer } });
    });

    it("another repo's item with the same number is never found", async () => {
      const other = await seedAccountWithRepo(admin, 515151);
      await seedWorkItem(admin, other.accountId, other.repoId, { ghNumber: 1203, stage: 'in_progress' });
      const result = await handleGithubWebhookEvent({ appUserPool, platformOpsPool }, 'pull_request', prFor(1203), `d-${randomUUID()}`);
      expect(result).toMatchObject({ handled: true, result: { applied: 'skipped' } });
    });

    it('a redelivered issues.opened for an issue the pipeline already took finds the root and creates no third row', async () => {
      const root = await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: 1204, kind: 'feature', stage: 'discussing' });
      await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: 1204, stage: 'closed' });
      const payload = loadFixture<GithubIssuePayload>('issue.opened.trusted.json');
      payload.issue.number = 1204;
      const result = await handleGithubWebhookEvent({ appUserPool, platformOpsPool }, 'issues', payload, `d-${randomUUID()}`);
      expect(result).toMatchObject({ handled: true, result: { applied: 'created', workItemId: root } });
      const n = await admin.query(`SELECT count(*)::int AS n FROM work_items WHERE account_id = $1 AND gh_number = 1204`, [refs.accountId]);
      expect(n.rows[0].n).toBe(2);
    });
  });

  describe("D#483 P1: an organization repo's owner is trusted by real permission, not by association", () => {
    const org = (assoc: string, login = 'org-owner') => {
      const payload = loadFixture<GithubIssuePayload>('issue.opened.trusted.json');
      payload.issue.user = { login };
      payload.issue.author_association = assoc;
      return payload;
    };
    let next = 1300;
    const run = async (payload: GithubIssuePayload, deps: Record<string, unknown> = {}) => {
      payload.issue.number = next++;
      const result = await handleGithubWebhookEvent({ appUserPool, platformOpsPool, ...deps }, 'issues', payload, `d-${randomUUID()}`);
      const rows = await admin.query(`SELECT provenance FROM work_items WHERE account_id = $1 AND gh_number = $2`, [refs.accountId, payload.issue.number]);
      return { result, items: rows.rows as Array<{ provenance: string }> };
    };
    const lookup = (permission: string, login = 'org-owner') => vi.fn(async (_input: { repoId: string; owner: string; name: string; number: number }) => ({ login, permission: permission as 'admin' }));

    it.each(['MEMBER', 'CONTRIBUTOR', 'COLLABORATOR', 'NONE'])('a %s whose real permission is admin or maintain creates an internal work item', async (assoc) => {
      for (const permission of ['admin', 'maintain']) {
        const look = lookup(permission);
        const { items } = await run(org(assoc), { issueAuthorPermission: look });
        expect(items).toEqual([{ provenance: 'internal' }]);
        expect(look).toHaveBeenCalledTimes(1);
      }
    });

    it.each(['write', 'triage', 'read', 'none'])('real permission %s is not trusted: no work item, as before', async (permission) => {
      const { items } = await run(org('MEMBER'), { issueAuthorPermission: lookup(permission) });
      expect(items).toEqual([]);
    });

    it('write collaborators stay untrusted unless the opt-in is set (then trusted, by the usual rule)', async () => {
      expect((await run(org('COLLABORATOR'), { issueAuthorPermission: lookup('write') })).items).toEqual([]);
      expect((await run(org('COLLABORATOR'), { issueAuthorPermission: lookup('write'), allowWritePermission: true })).items).toEqual([{ provenance: 'internal' }]);
    });

    it('an OWNER is trusted without any lookup', async () => {
      const look = lookup('none');
      const { items } = await run(org('OWNER'), { issueAuthorPermission: look });
      expect(items).toEqual([{ provenance: 'internal' }]);
      expect(look).not.toHaveBeenCalled();
    });

    it('fails closed: a throw, no answer, or an answer for a different login changes nothing', async () => {
      const warn = vi.fn((_message: string) => {});
      const throwing = vi.fn(async () => {
        throw new Error('issueAuthorLookup: request_failed secret-login');
      });
      expect((await run(org('MEMBER'), { issueAuthorPermission: throwing, warn })).items).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).not.toMatch(/secret-login|org-owner/);
      expect((await run(org('MEMBER'), { issueAuthorPermission: vi.fn(async () => null) })).items).toEqual([]);
      expect((await run(org('MEMBER'), { issueAuthorPermission: lookup('admin', 'someone-else') })).items).toEqual([]);
    });

    it('the login match ignores case; and the lookup never lowers what the association already granted', async () => {
      expect((await run(org('MEMBER', 'Org-Owner'), { issueAuthorPermission: lookup('admin', 'org-owner') })).items).toEqual([{ provenance: 'internal' }]);
      expect((await run(org('MEMBER'), { issueAuthorPermission: lookup('admin') })).items).toHaveLength(1);
    });

    it('no lookup is wired: the association alone decides (a MEMBER creates nothing)', async () => {
      expect((await run(org('MEMBER'))).items).toEqual([]);
    });

    it('only issues.opened is looked up: an edited event and other events never call it', async () => {
      const look = lookup('admin');
      const edited = org('MEMBER');
      edited.action = 'edited';
      edited.issue.number = 1400;
      await handleGithubWebhookEvent({ appUserPool, platformOpsPool, issueAuthorPermission: look }, 'issues', edited, `d-${randomUUID()}`);
      expect(look).not.toHaveBeenCalled();
    });

    it('the lookup is handed the resolved repo and the issue, nothing from the payload text', async () => {
      const look = lookup('admin');
      await run(org('MEMBER'), { issueAuthorPermission: look });
      expect(look.mock.calls[0]![0]).toEqual({ repoId: refs.repoId, owner: 'acme-corp', name: 'widgets', number: expect.any(Number) });
    });
  });
});
