import { describe, expect, it } from 'vitest';
import { parseVercelEnvPage, runSetupRequestCheck, unavailableVercelEnvSource, type CheckableRequest } from '../../src/setup-requests/checks.js';
import { checkReasonSentence } from '../../src/setup-requests/copy.js';
import { FakeVercel } from '../support/vercelEnvFake.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const REQ: CheckableRequest = { kind: 'env_var', checkKind: 'env_var_present', target: 'cloud-staging', envName: 'STRIPE_KEY', targetEnvironment: 'production' };
const SECRET = 'sk_live_NEVER_KEEP_THIS_VALUE';

/** D#598 P8b: the env-var check and its fixed reasons, against the strict Vercel listing fake. */
describe('env-var check (P8b)', () => {
  it('passes when the name is set for production, whatever else it is set for', async () => {
    const v = new FakeVercel().connect(ACCOUNT).project('cloud-staging', [{ key: 'STRIPE_KEY', value: SECRET, target: ['production', 'preview'] }]);
    expect(await runSetupRequestCheck(v.source(), ACCOUNT, REQ)).toEqual({ pass: true });
  });

  it('env_var_missing when the project lists no such name; a similar name does not count', async () => {
    const v = new FakeVercel().connect(ACCOUNT).project('cloud-staging', [{ key: 'STRIPE_KEY_2', value: 'x', target: ['production'] }, { key: 'stripe_key', value: 'x', target: ['production'] }]);
    expect(await runSetupRequestCheck(v.source(), ACCOUNT, REQ)).toEqual({ pass: false, reason: 'env_var_missing' });
  });

  it('env_var_wrong_target when it is set, but not for production (an older project lists one target as a string)', async () => {
    const v = new FakeVercel().connect(ACCOUNT).project('cloud-staging', [{ key: 'STRIPE_KEY', value: 'x', target: ['preview', 'development'] }]);
    expect(await runSetupRequestCheck(v.source(), ACCOUNT, REQ)).toEqual({ pass: false, reason: 'env_var_wrong_target' });
    v.setVar('cloud-staging', { key: 'STRIPE_KEY', value: 'x', target: 'preview' });
    expect(await runSetupRequestCheck(v.source(), ACCOUNT, REQ)).toEqual({ pass: false, reason: 'env_var_wrong_target' });
    v.setVar('cloud-staging', { key: 'STRIPE_KEY', value: 'x', target: 'production' });
    expect(await runSetupRequestCheck(v.source(), ACCOUNT, REQ)).toEqual({ pass: true });
  });

  it('check_unavailable, never a pass, for: no connection, an unknown project, a malformed project name, a 500, a body that is not a listing, a throw, and the production binding', async () => {
    const v = new FakeVercel().connect(ACCOUNT).project('cloud-staging', [{ key: 'STRIPE_KEY', value: 'x', target: ['production'] }]);
    const unavailable = { pass: false, reason: 'check_unavailable' };
    expect(await runSetupRequestCheck(v.source(), OTHER, REQ), 'no connection').toEqual(unavailable);
    expect(v.calls, 'an account with no connection never reaches the provider').toHaveLength(0);
    expect(await runSetupRequestCheck(v.revoke(ACCOUNT).source(), ACCOUNT, REQ), 'revoked token').toEqual(unavailable);
    v.connect(ACCOUNT);
    expect(await runSetupRequestCheck(v.source(), ACCOUNT, { ...REQ, target: 'no-such-project' }), 'unknown project').toEqual(unavailable);
    expect(await runSetupRequestCheck(v.source(), ACCOUNT, { ...REQ, target: 'Cloud Staging' }), 'malformed name').toEqual(unavailable);
    expect(await runSetupRequestCheck(v.failNext('http_500').source(), ACCOUNT, REQ), '500').toEqual(unavailable);
    expect(await runSetupRequestCheck(v.failNext('bad_body').source(), ACCOUNT, REQ), 'bad body').toEqual(unavailable);
    expect(await runSetupRequestCheck(v.failNext('throw').source(), ACCOUNT, REQ), 'throw').toEqual(unavailable);
    expect(await runSetupRequestCheck(unavailableVercelEnvSource, ACCOUNT, REQ), 'production binding').toEqual(unavailable);
    expect(unavailableVercelEnvSource.available).toBe(false);
    // and the fake is healthy again afterwards
    expect(await runSetupRequestCheck(v.source(), ACCOUNT, REQ)).toEqual({ pass: true });
  });

  it('a request that names no check this file runs is not checked (null), not failed', async () => {
    const v = new FakeVercel().connect(ACCOUNT);
    expect(await runSetupRequestCheck(v.source(), ACCOUNT, { ...REQ, checkKind: null })).toBeNull();
    expect(await runSetupRequestCheck(v.source(), ACCOUNT, { ...REQ, kind: 'app_not_installed', envName: null })).toBeNull();
    expect(v.calls).toHaveLength(0);
  });

  it('asks the provider once per check, for names: the fake refuses a request for decrypted values', async () => {
    const v = new FakeVercel().connect(ACCOUNT).project('cloud-staging', [{ key: 'STRIPE_KEY', value: SECRET, target: ['production'] }]);
    await runSetupRequestCheck(v.source(), ACCOUNT, REQ);
    expect(v.calls).toHaveLength(1);
    expect(v.calls[0]).toMatchObject({ accountId: ACCOUNT, project: 'cloud-staging' });
    expect(new URLSearchParams(v.calls[0]!.query).get('decrypt')).toBe('false');
    expect(v.rawRequest(ACCOUNT, 'cloud-staging', 'decrypt=true').status).toBe(400);
  });

  it('the listing parser keeps a name and its environments and nothing else: a value, an id, a type never leave it', () => {
    const body = { envs: [{ id: 'env_1', key: 'STRIPE_KEY', value: SECRET, type: 'plain', target: ['production'], comment: 'x', createdAt: 1 }] };
    const parsed = parseVercelEnvPage(body);
    expect(parsed).toEqual({ entries: [{ name: 'STRIPE_KEY', targets: ['production'] }], skipped: 0, next: null });
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
    // A body that is not the listing at all is null; one bad entry is skipped and counted, never a null listing.
    for (const bad of [null, undefined, 'x', 3, {}, { envs: 'x' }]) expect(parseVercelEnvPage(bad), JSON.stringify(bad)).toBeNull();
    const mixed = parseVercelEnvPage({ envs: [null, { key: 3, target: ['production'], value: SECRET }, { key: 'bad name', target: ['production'] }, { key: 'GOOD', target: ['preview'] }, { key: 'NO_TARGET' }, { key: 'BAD_TARGET', target: [1] }] });
    expect(mixed).toEqual({ entries: [{ name: 'GOOD', targets: ['preview'] }, { name: 'NO_TARGET', targets: [] }, { name: 'BAD_TARGET', targets: [] }], skipped: 5, next: null });
    expect(parseVercelEnvPage({ envs: [], pagination: { next: 1_700_000_000_000 } })?.next).toBe(1_700_000_000_000);
    expect(parseVercelEnvPage({ envs: [], pagination: { next: 'x' } })?.next).toBeNull();
  });

  it('the environment the check uses and the environment the sentence names are the request\'s one field', async () => {
    const v = new FakeVercel().connect(ACCOUNT).project('cloud-staging', [{ key: 'STRIPE_KEY', value: 'x', target: ['production'] }]);
    for (const environment of ['production', 'preview', 'development'] as const) {
      const request = { ...REQ, targetEnvironment: environment };
      const outcome = await runSetupRequestCheck(v.source(), ACCOUNT, request);
      expect(outcome).toEqual(environment === 'production' ? { pass: true } : { pass: false, reason: 'env_var_wrong_target' });
      if (outcome !== null && !outcome.pass) {
        expect(checkReasonSentence(outcome.reason, { name: 'STRIPE_KEY', project: 'cloud-staging', environment: request.targetEnvironment })).toBe(`STRIPE_KEY is set on cloud-staging, but not for ${environment}.`);
      }
    }
    v.setVar('cloud-staging', { key: 'STRIPE_KEY', value: 'x', target: ['preview'] });
    expect(await runSetupRequestCheck(v.source(), ACCOUNT, { ...REQ, targetEnvironment: 'preview' })).toEqual({ pass: true });
  });
});
