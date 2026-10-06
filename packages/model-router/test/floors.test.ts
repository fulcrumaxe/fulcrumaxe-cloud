import { describe, expect, it } from 'vitest';
import { applyCustomerOverride, assertRowMeetsFloor, meetsFloor } from '../src/floors.js';
import { route } from '../src/route.js';
import { validateRoutingRows } from '../src/tableSchema.js';
import type { RoutingRow } from '../src/types.js';

describe('floors', () => {
  it('security-reviewer and security-expert never run below Sonnet 5', () => {
    expect(meetsFloor('security-reviewer', 'haiku-4.5')).toBe(false);
    expect(meetsFloor('security-reviewer', 'sonnet-5')).toBe(true);
    expect(meetsFloor('security-reviewer', 'opus-5')).toBe(true);
    expect(meetsFloor('security-expert', 'haiku-4.5')).toBe(false);
  });

  it('a non-floored role has no floor', () => {
    expect(meetsFloor('executor', 'haiku-4.5')).toBe(true);
  });

  it('a table row putting security-reviewer on Haiku is rejected at load', () => {
    const rows: RoutingRow[] = [
      { role: 'security-reviewer', size: 'Small', model: 'haiku-4.5', rationale: 'bad' },
    ];
    expect(() => assertRowMeetsFloor('security-reviewer', 'haiku-4.5')).toThrow(/violates floor/);
    expect(() => validateRoutingRows(rows)).toThrow(/violates floor/);
  });

  it('a customer override to Haiku for security-expert is refused', () => {
    const result = applyCustomerOverride('security-expert', 'haiku-4.5');
    expect(result).toEqual({ accepted: false, reason: '"haiku-4.5" is below the floor ("sonnet-5") for role "security-expert"' });
  });

  it('a customer override to Opus for executor is honoured', () => {
    const result = applyCustomerOverride('executor', 'opus-5');
    expect(result).toEqual({ accepted: true, model: 'opus-5' });
  });

  it('route() rejects an invalid low override and falls back to the (floor-satisfying) table row', () => {
    const table = { version: 1, rows: [{ role: 'security-reviewer', size: 'Small' as const, model: 'sonnet-5' as const, rationale: 'table default' }] };
    const result = route({ role: 'security-reviewer', size: 'Small', repoSettings: { modelOverride: 'haiku-4.5' } }, table);
    expect(result.model).toBe('sonnet-5');
    expect(result.reason).toBe('table v1: security-reviewer/Small');
  });

  it('route() clamps to the floor even if the table row itself is below it (defense in depth)', () => {
    // A table row this low should never pass validateRoutingRows -- this
    // proves route() itself does not silently trust an unvalidated table.
    const table = { version: 1, rows: [{ role: 'security-reviewer', size: 'Small' as const, model: 'haiku-4.5' as const, rationale: 'corrupt fixture' }] };
    const result = route({ role: 'security-reviewer', size: 'Small' }, table);
    expect(result.model).toBe('sonnet-5');
    expect(result.reason).toBe('floor: security');
  });

  it('route() honours a valid raise-only override', () => {
    const table = { version: 1, rows: [{ role: 'executor', size: 'Small' as const, model: 'haiku-4.5' as const, rationale: 'table default' }] };
    const result = route({ role: 'executor', size: 'Small', repoSettings: { modelOverride: 'opus-5' } }, table);
    expect(result).toEqual({ model: 'opus-5', reason: 'customer override', tableVersion: 1, backend: 'claude-code', provider: 'anthropic' });
  });
});
