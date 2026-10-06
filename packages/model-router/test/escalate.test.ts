import { describe, expect, it } from 'vitest';
import { escalate } from '../src/escalate.js';
import type { ModelId } from '../src/types.js';

describe('escalate()', () => {
  it('goes up exactly one tier on a fail', () => {
    const result = escalate({ role: 'executor', model: 'haiku-4.5', tableVersion: 1, runStatus: 'fail' });
    expect(result).toEqual({ model: 'sonnet-5', reason: 'escalated: fail', tableVersion: 1 });
  });

  it('goes up exactly one tier on a timed_out', () => {
    const result = escalate({ role: 'executor', model: 'sonnet-5', tableVersion: 1, runStatus: 'timed_out' });
    expect(result).toEqual({ model: 'opus-5', reason: 'escalated: timed_out', tableVersion: 1 });
  });

  it('goes up exactly one tier on a needs-fix review verdict', () => {
    const result = escalate({ role: 'executor', model: 'haiku-4.5', tableVersion: 1, reviewVerdict: 'needs-fix' });
    expect(result).toEqual({ model: 'sonnet-5', reason: 'escalated: needs-fix', tableVersion: 1 });
  });

  it('Opus 5 stays Opus 5', () => {
    const result = escalate({ role: 'executor', model: 'opus-5', tableVersion: 1, runStatus: 'fail' });
    expect(result?.model).toBe('opus-5');
  });

  it('does not escalate on killed_spend -- spend kills do not escalate', () => {
    expect(escalate({ role: 'executor', model: 'haiku-4.5', tableVersion: 1, runStatus: 'killed_spend' })).toBeNull();
  });

  it('does not escalate on a plain success', () => {
    expect(escalate({ role: 'executor', model: 'haiku-4.5', tableVersion: 1, runStatus: 'succeeded' })).toBeNull();
  });

  it('needs-fix wins even if runStatus is also present as something non-escalating', () => {
    const result = escalate({
      role: 'executor',
      model: 'haiku-4.5',
      tableVersion: 1,
      runStatus: 'succeeded',
      reviewVerdict: 'needs-fix',
    });
    expect(result?.reason).toBe('escalated: needs-fix');
  });

  describe('security floor (CWE-20/CWE-693 fix round)', () => {
    it('throws instead of defaulting an unknown model to Haiku 4.5', () => {
      // On 3945419, tierRank('not-a-model') === -1, so
      // Math.min(-1 + 1, 2) === 0 resolved straight to 'haiku-4.5' here --
      // for ANY role, floored or not. escalate() must refuse instead.
      expect(() =>
        escalate({ role: 'executor', model: 'not-a-model' as ModelId, tableVersion: 1, runStatus: 'fail' }),
      ).toThrow(/unknown model/);
    });

    it('escalating a security-reviewer run from an unknown/corrupted model never yields a model below Sonnet 5', () => {
      expect(() =>
        escalate({
          role: 'security-reviewer',
          model: 'legacy-claude-2' as ModelId,
          tableVersion: 1,
          reviewVerdict: 'needs-fix',
        }),
      ).toThrow(/unknown model/);
    });

    it('escalating a security-expert run from an unknown/corrupted model never yields a model below Sonnet 5', () => {
      expect(() =>
        escalate({
          role: 'security-expert',
          model: '' as ModelId,
          tableVersion: 1,
          runStatus: 'timed_out',
        }),
      ).toThrow(/unknown model/);
    });

    it('a floored role escalating from a known model never drops below Sonnet 5 (defense in depth via meetsFloor/floorFor)', () => {
      const result = escalate({ role: 'security-reviewer', model: 'haiku-4.5', tableVersion: 1, runStatus: 'fail' });
      expect(result?.model).toBe('sonnet-5');
    });
  });
});
