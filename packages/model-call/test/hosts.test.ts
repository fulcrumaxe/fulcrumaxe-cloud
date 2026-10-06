import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { networkPolicy } from '../../runner/src/networkPolicy.js';
import { MODEL_HOSTS, hostFor } from '../src/hosts.js';

describe('S2d: the host is a constant two-host table', () => {
  it('matches packages/runner networkPolicy.ts for both providers, and has exactly two entries', () => {
    expect(Object.keys(MODEL_HOSTS).sort()).toEqual(['ai_gateway', 'anthropic']);
    for (const provider of ['ai_gateway', 'anthropic'] as const) {
      const rules = networkPolicy('executor' as never, 'team' as never, { provider, githubForwardHost: 'gh-proxy.fulcrumaxe.app' });
      expect(MODEL_HOSTS[provider]).toBe(rules.find((r) => r.purpose === 'model')?.host);
    }
  });

  it('never resolves an unknown or prototype-chain provider to a host', () => {
    for (const bad of ['evil.example.com', 'constructor', '__proto__', '']) expect(() => hostFor(bad)).toThrow(/unknown provider/);
  });

  it('a row carrying a foreign provider string makes no request', async () => {
    vi.resetModules();
    vi.doMock('@fx/model-connection/keyAccess', () => ({
      withOpenedKey: async (_c: unknown, use: (o: { provider: string; key: string }) => Promise<unknown>) => use({ provider: 'evil.example.com', key: 'vck_x0123456789' }),
    }));
    const { completeJson } = await import('../src/completeJson.js');
    const fetchImpl = vi.fn();
    const ctx = { pool: {}, platformOpsPool: {}, principal: { accountId: 'a', userId: 'u' }, kek: {}, fetchImpl } as never;
    await expect(completeJson(ctx, { role: 'r', system: '', messages: [], schema: z.unknown(), maxOutputTokens: 1, timeoutMs: 1 })).rejects.toThrow(/unknown provider/);
    expect(fetchImpl).not.toHaveBeenCalled();
    vi.doUnmock('@fx/model-connection/keyAccess');
  });
});
