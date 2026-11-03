import { describe, expect, it } from 'vitest';
import { ROUTES } from '../src/routes/index.js';
import { effectivePrincipals } from '../src/registry.js';

/** D#598 P1g-3a: Keep, Replace and the undo of managed are a person's own clicks: session only, owner or admin, never a token (the generic token inventory also sends a token at each). */
describe('the answers to a branch someone pushed to are session-only owner-or-admin routes', () => {
  const OPS = ['keepPublicBranch', 'replacePublicBranch', 'releasePublicBranch'];
  it.each(OPS)('%s accepts a session only, needs owner or admin, and is never idempotent-keyed', (operationId) => {
    const entry = ROUTES.find((r) => r.operationId === operationId);
    expect(entry).toBeDefined();
    expect(effectivePrincipals(entry!)).toEqual(['session']);
    expect(entry!.minRole).toBe('admin');
    expect(entry!.method).toBe('POST');
    expect(entry!.idempotency).toBe('never');
  });
});
