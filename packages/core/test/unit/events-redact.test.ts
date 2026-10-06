import { describe, expect, it } from 'vitest';
import { redactEventPayload, redactEventText } from '../../src/events/redact.js';

/**
 * D#2 H11 criterion 2 (redaction at source, corrected by D#31 comment
 * 18494573 C5 to add `fxat_…` and `whsec_…`): "events are redacted
 * before insert into run_events for injected fake secrets (gateway key,
 * installation token pattern `ghs_…`, Stripe `sk_…`/`whsec_…`,
 * JWT-shaped strings). A test inserts events containing each and asserts
 * the stored payload and the stream both lack them." This file proves
 * the pure redaction function fires on every one of those shapes; the
 * "stored payload and the stream both lack them" half is
 * `packages/runner/test/runStatusWriter.redaction.pg.test.ts` (the
 * writer + `listRunEvents` end to end, against real Postgres).
 */

const FAKE_SECRETS: Record<string, string> = {
  'AI Gateway key (vck_)': 'vck_deadbeefCAFEBABE1234567890',
  'GitHub installation token (ghs_)': 'ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
  'Stripe live secret key (sk_live_)': 'sk_live_ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'Stripe test secret key (sk_test_)': 'sk_test_ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'webhook signing secret (whsec_)': 'whsec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh',
  'D#31 API token (fxat_)': 'fxat_' + 'a'.repeat(49),
  'GitHub personal token (ghp_)': 'ghp_' + 'A1b2C3d4E5'.repeat(4),
  'GitHub OAuth token (gho_)': 'gho_' + 'A1b2C3d4E5'.repeat(4),
  'GitHub fine-grained PAT (github_pat_)': 'github_pat_11ABCDEFG0' + 'a1B2c3D4e5_'.repeat(5),
  'Anthropic API key (sk-ant-api03-)': 'sk-ant-api03-' + 'aB1-_cD2eF'.repeat(5),
  'Anthropic key (bare sk-ant-)': 'sk-ant-' + 'aB1cD2eF3g'.repeat(3),
  'AWS access key id (AKIA)': 'AKIAABCDEFGHIJKLMNOP',
  'JWT-shaped string': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
};

describe('events/redact (D#2 H11 criterion 2)', () => {
  it.each(Object.entries(FAKE_SECRETS))('redactEventText strips a %s', (_label, secret) => {
    const text = `before ${secret} after`;
    const out = redactEventText(text);
    expect(out).not.toContain(secret);
    expect(out).toBe('before [redacted] after');
  });

  it.each(Object.entries(FAKE_SECRETS))('redactEventPayload redacts a %s used as an object KEY (top level and nested)', (_label, secret) => {
    const out = redactEventPayload({ [secret]: 'v', nested: { [`x_${secret}`]: [{ [secret]: 1 }], keep: 'ok' } });
    const json = JSON.stringify(out);
    expect(json).not.toContain(secret);
    expect(json).toContain('[redacted]');
    expect((out as { nested: { keep: string } }).nested.keep).toBe('ok');
  });

  it('two secret keys that collapse to the same redacted text keep both values under distinct names', () => {
    const a = 'ghp_' + 'A1b2C3d4E5'.repeat(4);
    const b = 'gho_' + 'A1b2C3d4E5'.repeat(4);
    const out = redactEventPayload({ [a]: 1, [b]: 2 }) as Record<string, number>;
    expect(Object.keys(out)).toHaveLength(2);
    expect(Object.values(out).sort()).toEqual([1, 2]);
    expect(JSON.stringify(out)).not.toContain(a);
  });

  it('redactEventPayload redacts every string value recursively (objects, arrays, nesting)', () => {
    const secret = FAKE_SECRETS['GitHub installation token (ghs_)']!;
    const payload = {
      message: `token leaked: ${secret}`,
      nested: { deeper: [`also here: ${secret}`, 'clean value'] },
      role: 'executor',
      count: 3,
      ok: true,
      empty: null,
    };
    const redacted = redactEventPayload(payload);
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(redacted.role).toBe('executor');
    expect(redacted.count).toBe(3);
    expect(redacted.ok).toBe(true);
    expect(redacted.empty).toBeNull();
    expect(redacted.nested.deeper[1]).toBe('clean value');
  });

  it('a payload with no secret-shaped text is returned unchanged in content', () => {
    const payload = { from: 'pending', to: 'running' };
    expect(redactEventPayload(payload)).toEqual(payload);
  });

  it('a value plainly resembling "Powered by Claude" copy is left alone (not a secret shape)', () => {
    expect(redactEventText('Powered by Claude')).toBe('Powered by Claude');
  });
});
