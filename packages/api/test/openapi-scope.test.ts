import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROUTES } from '../src/routes/index.js';
import { effectivePrincipals } from '../src/registry.js';

const OPENAPI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'openapi.json');

type Op = { security: Record<string, string[]>[]; 'x-fx-token-self-only'?: boolean };

describe('openapi.json states each operation token scope', () => {
  const doc = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as { paths: Record<string, Record<string, Op>> };

  it('every route agrees with the registry: scope, self-only, or no token entry', () => {
    let tokenRoutes = 0;
    let selfOnly = 0;
    for (const route of ROUTES) {
      const op = doc.paths[route.path]?.[route.method.toLowerCase()];
      const label = `${route.method} ${route.path}`;
      if (!op) throw new Error(`${label} is missing from openapi.json`);
      const tokenEntries = op.security.filter((s) => 'token' in s);
      const principals = effectivePrincipals(route);
      if (principals.includes('session')) {
        expect(op.security.filter((s) => 'session' in s), label).toEqual([{ session: [] }]);
      }
      if (!principals.includes('token')) {
        expect(tokenEntries, `${label} is session-only`).toEqual([]);
        expect(op['x-fx-token-self-only'], label).toBeUndefined();
        continue;
      }
      tokenRoutes++;
      expect(tokenEntries, label).toHaveLength(1);
      if (route.tokenSelfOnly) {
        selfOnly++;
        expect(tokenEntries[0], label).toEqual({ token: [] });
        expect(op['x-fx-token-self-only'], label).toBe(true);
      } else {
        expect(route.scope, `${label} accepts tokens without a scope`).toBeDefined();
        expect(tokenEntries[0], label).toEqual({ token: [route.scope] });
        expect(op['x-fx-token-self-only'], label).toBeUndefined();
      }
    }
    expect(tokenRoutes).toBeGreaterThan(0);
    expect(selfOnly).toBe(1);
  });
});
