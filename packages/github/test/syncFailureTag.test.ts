import { describe, expect, it } from 'vitest';
import { InstallationTokenError } from '../src/index.js';
import { atStage, syncFailureTag } from '../src/syncFailureTag.js';

/**
 * The swallowed repo-sync failure is logged as a tag. Whatever an error carries
 * (class name, code, reason, an upstream message), the tag must stay inside a
 * narrow alphabet and must never repeat a token, a JWT, a repo or owner name.
 */
const TOKEN = 'ghs_16C7e42F292c6912E7710c838347Ae178B4a';
const PAT = 'github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwx';
const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjMifQ.c2lnbmF0dXJl';
const HOSTILE = [
  'acme/widgets',
  'acme/widgets\nsecond line',
  `Bad credentials ${TOKEN}`,
  `Not Found: /repos/acme/widgets`,
  `Repository 'acme/secret-repo' not found`,
  `line1\r\nBearer ${JWT}`,
  '../../etc/passwd',
  'x'.repeat(500),
  'name with spaces',
  '',
  TOKEN,
  PAT,
  JWT,
  '12345678',
  '<script>alert(1)</script>',
  '"quoted" \\ back',
];
const ALLOWED_OUTPUT = /^[A-Za-z0-9_.:" -]*$/;
const FORBIDDEN_FRAGMENTS = ['ghs_', 'github_pat_', 'eyJ', 'acme', 'widgets', 'secret-repo', '/', '\n', '\r', 'passwd', 'script'];

function expectClean(tag: string): void {
  expect(tag).toMatch(ALLOWED_OUTPUT);
  for (const f of FORBIDDEN_FRAGMENTS) expect(tag, `tag must not contain ${JSON.stringify(f)}`).not.toContain(f);
}

describe('syncFailureTag', () => {
  it('reports the stage, class, reason and status of a mint failure and the known upstream phrase behind it', async () => {
    const requesterError = Object.assign(new Error('access_token_mint_failed'), {
      status: 403,
      ghMessage: 'Request forbidden by administrative rules Please make sure your request has a User-Agent header',
    });
    const err = await atStage('mint_token', Promise.reject(new InstallationTokenError('mint_failed', { cause: requesterError }))).catch((e) => e);
    expect(syncFailureTag(err)).toBe('mint_token InstallationTokenError mint_failed cause: Error 403 github: "request forbidden by administrative rules"');
  });

  it('marks the first stage only and rethrows the same error object', async () => {
    const original = new Error('boom');
    const inner = atStage('list_repos', Promise.reject(original));
    const caught = await atStage('write_rows', inner).catch((e) => e);
    expect(caught).toBe(original);
    expect(syncFailureTag(caught)).toBe('list_repos Error');
  });

  it('says unknown_stage for an error that never went through atStage, and survives non-error throws', () => {
    expect(syncFailureTag(new TypeError('x'))).toBe('unknown_stage TypeError');
    for (const v of [null, undefined, 'a string', 42, {}, []]) expect(syncFailureTag(v)).toBe('unknown_stage');
  });

  it('never emits hostile names, codes, reasons, stages or upstream messages (fuzz)', () => {
    let checked = 0;
    for (const hostile of HOSTILE) {
      for (const field of ['name', 'code', 'reason', 'fxStage', 'status', 'ghMessage'] as const) {
        const shaped = (v: unknown) => Object.assign(new Error('m'), { [field]: v });
        const withCause = Object.assign(new Error('outer'), { cause: shaped(hostile), reason: hostile, code: hostile, name: hostile });
        for (const err of [shaped(hostile), withCause, Object.assign(shaped(hostile), { cause: hostile })]) {
          expectClean(syncFailureTag(err));
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('never repeats an upstream message that merely starts with a known phrase plus a name', () => {
    const cause = { status: 404, ghMessage: "Not Found acme/widgets ghs_16C7e42F292c6912E7710c838347Ae178B4a".replace(/[^A-Za-z ]/g, '') };
    expectClean(syncFailureTag(Object.assign(new Error('e'), { cause })));
    const unknown = { status: 422, ghMessage: 'Repository acmewidgets could not be found' };
    expect(syncFailureTag(Object.assign(new Error('e'), { cause: unknown }))).toBe('unknown_stage Error cause: 422');
  });

  it('drops a status that is not an HTTP status', () => {
    expect(syncFailureTag(Object.assign(new Error('e'), { status: 123456789 }))).toBe('unknown_stage Error');
    expect(syncFailureTag(Object.assign(new Error('e'), { status: 1.5 }))).toBe('unknown_stage Error');
  });
});
