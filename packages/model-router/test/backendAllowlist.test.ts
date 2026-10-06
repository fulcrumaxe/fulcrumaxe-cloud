import { describe, expect, it } from 'vitest';
import {
  FLOORED_ALLOWLIST,
  FLOORED_PIN,
  backendForRole,
  isAliasLike,
  isAllowlisted,
} from '../src/backendAllowlist.js';
import { applyCustomerOverride, meetsFloor } from '../src/floors.js';
import { route } from '../src/route.js';

const CC = { backend: 'claude-code', provider: 'anthropic' } as const;
const floored = ['security-reviewer', 'security-expert'];
const table = (role: string, model: 'haiku-4.5' | 'sonnet-5' | 'opus-5') => ({
  version: 3,
  rows: [{ role, size: 'Small' as const, model, rationale: 'fixture' }],
});

describe('allowlist keying', () => {
  it('lists only exact (backend, provider, model) triples', () => {
    expect(isAllowlisted({ ...CC, model: 'sonnet-5' })).toBe(true);
    expect(isAllowlisted({ ...CC, model: 'opus-5' })).toBe(true);
    expect(isAllowlisted({ ...CC, model: 'haiku-4.5' })).toBe(false);
    expect(isAllowlisted({ backend: 'opencode', provider: 'anthropic', model: 'sonnet-5' })).toBe(false);
    expect(isAllowlisted({ backend: 'claude-code', provider: 'openrouter', model: 'sonnet-5' })).toBe(false);
    expect(isAllowlisted({ ...CC, model: 'Sonnet-5' })).toBe(false);
  });

  it.each(['openrouter/auto', 'auto', 'sonnet-5:floor', 'sonnet-5:nitro', 'sonnet-5 ', ' sonnet-5'])(
    'refuses the alias or variant %j',
    (model) => {
      expect(isAliasLike(model)).toBe(true);
      expect(isAllowlisted({ ...CC, model })).toBe(false);
    },
  );

  it('no listed entry is alias-shaped and none is a non-Claude target', () => {
    for (const e of FLOORED_ALLOWLIST) {
      expect(isAliasLike(e.model)).toBe(false);
      expect({ backend: e.backend, provider: e.provider }).toEqual(FLOORED_PIN);
    }
  });

  it('the list and pin are frozen', () => {
    expect(Object.isFrozen(FLOORED_ALLOWLIST)).toBe(true);
    expect(Object.isFrozen(FLOORED_PIN)).toBe(true);
  });
});

describe('meetsFloor on unknown models', () => {
  it.each(floored)('%s: an unranked model is false, never undefined', (role) => {
    for (const model of ['gpt-6', 'openrouter/auto', 'sonnet-5:nitro', '', 'opus-6']) {
      expect(meetsFloor(role, model)).toBe(false);
    }
  });

  it.each(floored)('%s: a ranked model on a non-pinned backend is false', (role) => {
    expect(meetsFloor(role, 'opus-5', { backend: 'opencode', provider: 'anthropic' })).toBe(false);
    expect(meetsFloor(role, 'opus-5', { backend: 'claude-code', provider: 'openrouter' })).toBe(false);
    expect(meetsFloor(role, 'opus-5', CC)).toBe(true);
  });

  it('a non-floored role is unaffected', () => {
    expect(meetsFloor('executor', 'gpt-6')).toBe(true);
  });
});

describe('applyCustomerOverride for floored roles', () => {
  it.each(floored)('%s: an unlisted model is refused with a reason (the 422 path)', (role) => {
    for (const model of ['gpt-6', 'openrouter/auto', 'sonnet-5:floor']) {
      const r = applyCustomerOverride(role, model);
      expect(r.accepted).toBe(false);
      if (!r.accepted) expect(r.reason).toMatch(/not on the allowlist/);
    }
  });

  it('a listed model on a non-pinned backend is refused', () => {
    const r = applyCustomerOverride('security-expert', 'opus-5', { backend: 'opencode', provider: 'openrouter' });
    expect(r.accepted).toBe(false);
  });

  it('a listed model on the pin is accepted', () => {
    expect(applyCustomerOverride('security-reviewer', 'opus-5')).toEqual({ accepted: true, model: 'opus-5' });
  });

  it('a non-floored role still takes any override', () => {
    expect(applyCustomerOverride('executor', 'haiku-4.5')).toEqual({ accepted: true, model: 'haiku-4.5' });
  });
});

describe('floored roles are pinned to claude-code', () => {
  const accountDefault = { backend: 'opencode', provider: 'openrouter' };

  it('backendForRole ignores the account default for floored roles only', () => {
    expect(backendForRole(true, accountDefault)).toEqual(FLOORED_PIN);
    expect(backendForRole(false, accountDefault)).toEqual(accountDefault);
    expect(backendForRole(false)).toEqual(FLOORED_PIN);
  });

  it.each(floored)('route() for %s returns claude-code whatever the account default', (role) => {
    const r = route({ role, size: 'Small', accountBackend: accountDefault }, table(role, 'sonnet-5'));
    expect(r.backend).toBe('claude-code');
    expect(r.provider).toBe('anthropic');
    expect(r.model).toBe('sonnet-5');
  });

  it('route() for a non-floored role follows the account default', () => {
    const r = route({ role: 'executor', size: 'Small', accountBackend: accountDefault }, table('executor', 'haiku-4.5'));
    expect(r.backend).toBe('opencode');
    expect(r.provider).toBe('openrouter');
  });

  it('route() ignores an alias override on a floored role', () => {
    const r = route(
      { role: 'security-reviewer', size: 'Small', repoSettings: { modelOverride: 'openrouter/auto' as never } },
      table('security-reviewer', 'sonnet-5'),
    );
    expect(r.model).toBe('sonnet-5');
    expect(r.reason).toBe('table v3: security-reviewer/Small');
  });

  it('route() clamps an unranked table model on a floored role to the floor', () => {
    const r = route({ role: 'security-expert', size: 'Small' }, table('security-expert', 'gpt-6' as never));
    expect(r.model).toBe('sonnet-5');
    expect(r.reason).toBe('floor: security');
  });
});
