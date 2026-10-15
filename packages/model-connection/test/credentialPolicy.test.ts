import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_BACKENDS,
  checkCredentialPolicy,
  defaultBackendFor,
  type Placement,
} from '../src/credentialPolicy.js';
import { open, seal } from '../src/crypto.js';
import { DecryptionFailedError } from '../src/errors.js';
import {
  buildAad,
  connectionAad,
  CREDENTIAL_KINDS,
  CURRENT_AAD_VERSION,
  DEFAULT_KIND_OF_PROVIDER,
  PROVIDER_OF_KIND,
  type CredentialKind,
} from '../src/types.js';
import { fakeKekSource } from './helpers/fakeKek.js';

/**
 * D#221 MC1, pure parts: the credential matrix and the AAD that binds a sealed key to its kind.
 *
 * The matrix below is written out by hand from the Spec's table, NOT derived from the module's own data: a derived
 * expectation would pass for any table. Rows: backend, then the placements each kind is allowed on.
 */
const ALLOWED: Record<string, Partial<Record<CredentialKind, Placement[]>>> = {
  'claude-code': { ai_gateway: ['hosted', 'self_hosted'], anthropic: ['hosted', 'self_hosted'] },
  codex: {
    ai_gateway: ['hosted', 'self_hosted'],
    openai_api_key: ['hosted', 'self_hosted'],
    codex_access_token: ['hosted', 'self_hosted'],
    chatgpt_oauth: ['hosted'],
  },
  opencode: { ai_gateway: ['hosted', 'self_hosted'], openai_api_key: ['hosted', 'self_hosted'] },
};

describe('MC1: the credential policy matrix', () => {
  it('names exactly the three backends and the five kinds', () => {
    expect([...CREDENTIAL_BACKENDS]).toEqual(['claude-code', 'codex', 'opencode']);
    expect([...CREDENTIAL_KINDS]).toEqual(['ai_gateway', 'anthropic', 'openai_api_key', 'codex_access_token', 'chatgpt_oauth']);
  });

  it('allows exactly the listed backend x kind x placement cells and refuses all the rest (every one of the 30 cells)', () => {
    let allowedCount = 0;
    for (const backend of CREDENTIAL_BACKENDS) {
      for (const credentialKind of CREDENTIAL_KINDS) {
        for (const placement of ['hosted', 'self_hosted'] as const) {
          const expected = ALLOWED[backend]![credentialKind]?.includes(placement) === true;
          const decision = checkCredentialPolicy({ backend, credentialKind, placement });
          expect(decision.ok, `${backend} / ${credentialKind} / ${placement}`).toBe(expected);
          if (!decision.ok) expect(decision.reason).toBe('credential_not_allowed');
          if (expected) allowedCount += 1;
        }
      }
    }
    expect(allowedCount).toBe(15);
  });

  it('keeps the claude-code row unchanged: no OpenAI kind and no plan sign-in, whatever the placement', () => {
    for (const credentialKind of ['openai_api_key', 'codex_access_token', 'chatgpt_oauth'] as const) {
      for (const placement of ['hosted', 'self_hosted'] as const) {
        expect(checkCredentialPolicy({ backend: 'claude-code', credentialKind, placement }).ok).toBe(false);
      }
    }
  });

  it('refuses any plan sign-in for opencode, and the ChatGPT plan on a customer machine for codex', () => {
    expect(checkCredentialPolicy({ backend: 'opencode', credentialKind: 'chatgpt_oauth', placement: 'hosted' }).ok).toBe(false);
    expect(checkCredentialPolicy({ backend: 'opencode', credentialKind: 'codex_access_token', placement: 'hosted' }).ok).toBe(false);
    expect(checkCredentialPolicy({ backend: 'codex', credentialKind: 'chatgpt_oauth', placement: 'self_hosted' }).ok).toBe(false);
  });

  it('refuses an unknown backend, kind or placement by name, never allowing by default', () => {
    const base = { backend: 'codex', credentialKind: 'openai_api_key', placement: 'hosted' };
    for (const backend of ['Codex', 'claude_code', '', 'cursor', '__proto__', 'constructor', 'toString']) {
      expect(checkCredentialPolicy({ ...base, backend })).toEqual({ ok: false, reason: 'unknown_backend' });
    }
    for (const credentialKind of ['openai', 'api_key', '', 'ChatGPT_oauth', '__proto__', 'constructor']) {
      expect(checkCredentialPolicy({ ...base, credentialKind })).toEqual({ ok: false, reason: 'unknown_credential_kind' });
    }
    for (const placement of ['cloud', '', 'Hosted', '__proto__']) {
      expect(checkCredentialPolicy({ ...base, placement })).toEqual({ ok: false, reason: 'unknown_placement' });
    }
  });

  it('keeps provider, default kind and default backend consistent', () => {
    for (const kind of CREDENTIAL_KINDS) {
      // A kind's default backend is always one the matrix allows for that kind on our own hosts.
      expect(checkCredentialPolicy({ backend: defaultBackendFor(kind), credentialKind: kind, placement: 'hosted' }).ok).toBe(true);
    }
    for (const [provider, kind] of Object.entries(DEFAULT_KIND_OF_PROVIDER)) {
      expect(PROVIDER_OF_KIND[kind]).toBe(provider);
    }
    expect(DEFAULT_KIND_OF_PROVIDER.openai).toBe('openai_api_key');
  });
});

describe('MC1: the AAD binds the credential kind', () => {
  const accountId = randomUUID();
  const connectionId = randomUUID();
  const kek = fakeKekSource().keyFor(1);

  it('uses a different AAD for every kind, so a sealed row cannot be moved into another kind', () => {
    const seen = new Set(CREDENTIAL_KINDS.map((credentialKind) => connectionAad({ accountId, connectionId, credentialKind, aadVersion: 2 }).toString('utf8')));
    expect(seen.size).toBe(CREDENTIAL_KINDS.length);
    for (const aad of seen) expect(aad).toContain(accountId);
    for (const aad of seen) expect(aad).toContain(connectionId);
  });

  it('opens only under the kind it was sealed for', () => {
    const sealed = seal({ kek, aad: connectionAad({ accountId, connectionId, credentialKind: 'openai_api_key', aadVersion: CURRENT_AAD_VERSION }) }, 'sk-proj-x');
    expect(open({ kek, aad: connectionAad({ accountId, connectionId, credentialKind: 'openai_api_key', aadVersion: 2 }) }, sealed)).toBe('sk-proj-x');
    for (const other of CREDENTIAL_KINDS.filter((k) => k !== 'openai_api_key')) {
      expect(() => open({ kek, aad: connectionAad({ accountId, connectionId, credentialKind: other, aadVersion: 2 }) }, sealed), other).toThrow(DecryptionFailedError);
    }
    // Nor under the original, kind-less AAD, nor under another row or account.
    expect(() => open({ kek, aad: buildAad(accountId, connectionId) }, sealed)).toThrow(DecryptionFailedError);
    expect(() => open({ kek, aad: connectionAad({ accountId, connectionId: randomUUID(), credentialKind: 'openai_api_key', aadVersion: 2 }) }, sealed)).toThrow(DecryptionFailedError);
  });

  it('keeps version 1 (the original AAD) for the two original kinds only', () => {
    const legacy = buildAad(accountId, connectionId);
    for (const credentialKind of ['ai_gateway', 'anthropic'] as const) {
      expect(connectionAad({ accountId, connectionId, credentialKind, aadVersion: 1 }).equals(legacy)).toBe(true);
    }
    // A caller that does not know the kind (the original ports) gets the original AAD.
    expect(connectionAad({ accountId, connectionId }).equals(legacy)).toBe(true);
    for (const credentialKind of ['openai_api_key', 'codex_access_token', 'chatgpt_oauth']) {
      expect(() => connectionAad({ accountId, connectionId, credentialKind, aadVersion: 1 })).toThrow(DecryptionFailedError);
    }
  });

  it('fails closed on an unknown version or kind, and on version 2 without a kind', () => {
    for (const aadVersion of [0, 3, -1, 1.5, Number.NaN]) {
      expect(() => connectionAad({ accountId, connectionId, credentialKind: 'ai_gateway', aadVersion })).toThrow(DecryptionFailedError);
    }
    expect(() => connectionAad({ accountId, connectionId, credentialKind: 'something_else', aadVersion: 2 })).toThrow(DecryptionFailedError);
    expect(() => connectionAad({ accountId, connectionId, aadVersion: 2 })).toThrow(DecryptionFailedError);
  });
});
