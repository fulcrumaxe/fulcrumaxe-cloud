import { describe, expect, it } from 'vitest';
import { clampForVisibility } from '../src/publicRepoClamp.js';

/** D#845 ON-10e2b: only a clearly private repository keeps the disposition it was given. */
describe('clampForVisibility', () => {
  it.each(['act', 'announce', 'ask'] as const)('%s stays as it is on a private repository', (disposition) => {
    expect(clampForVisibility(disposition, 'private')).toBe(disposition);
  });

  it.each(['act', 'announce', 'ask'] as const)('%s becomes ask on a public repository and on one whose visibility could not be read', (disposition) => {
    expect(clampForVisibility(disposition, 'public')).toBe('ask');
    expect(clampForVisibility(disposition, 'unknown')).toBe('ask');
  });

  it('a value outside the type system (a visibility a broken reader invented) is not private, so it asks', () => {
    expect(clampForVisibility('act', 'Private' as never)).toBe('ask');
    expect(clampForVisibility('act', undefined as never)).toBe('ask');
  });
});
