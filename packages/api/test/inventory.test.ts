import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ROUTES } from '../src/routes/index.js';
import { effectivePrincipals, matchRoute, validateRegistry, type RouteEntry } from '../src/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = path.join(__dirname, '..', 'openapi.json');

/**
 * D#31 API-1 criterion 2: "The registry's (method, path) set equals the
 * set the catch-all dispatches and the set of paths in openapi.json."
 */
function registryKeySet(routes: readonly RouteEntry[]): Set<string> {
  return new Set(routes.map((r) => `${r.method} ${r.path}`));
}

function committedOpenApiKeySet(): Set<string> {
  const doc = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const keys = new Set<string>();
  for (const [path_, methods] of Object.entries(doc.paths)) {
    for (const method of Object.keys(methods)) {
      keys.add(`${method.toUpperCase()} ${path_}`);
    }
  }
  return keys;
}

describe('inventory: registry == catch-all dispatch == openapi.json paths', () => {
  it('the committed openapi.json declares exactly the registry\'s (method, path) set', () => {
    // Code review (non-blocking note, this PR): this used to compare
    // `buildOpenApiDocument(ROUTES)` -- recomputed in memory from the
    // SAME `ROUTES` array `registryKeySet` below already reads -- against
    // itself, so it could never independently catch drift from the
    // actual committed file (`openapi-drift.test.ts` already carries
    // that coverage). Reads the file this test's own name and comment
    // claim to check, the same way `openapi-drift.test.ts` does.
    const registryKeys = registryKeySet(ROUTES);
    const openApiKeys = committedOpenApiKeySet();
    expect(openApiKeys).toEqual(registryKeys);
  });

  it('the catch-all dispatch table (matchRoute) resolves every registry entry at its own path', () => {
    for (const entry of ROUTES) {
      // No path-param entries exist in API-1b's own registry (it is
      // empty -- see routes/index.ts); a later task's own inventory
      // coverage extends this the same way -- substituting a literal for
      // every `{name}` segment.
      const concretePath = entry.path.replace(/\{[^}]+\}/g, 'x');
      const match = matchRoute(ROUTES, entry.method, concretePath);
      expect(match?.entry.operationId).toBe(entry.operationId);
    }
  });

  it('an unregistered path 404s (matchRoute returns null)', () => {
    expect(matchRoute(ROUTES, 'GET', '/api/v1/does-not-exist')).toBeNull();
    expect(matchRoute(ROUTES, 'GET', '/api/account')).toBeNull();
    expect(matchRoute(ROUTES, 'GET', '/api/v2/account')).toBeNull();
  });

  /**
   * Security fix round item 2 (CWE-755, security review of this PR): a
   * malformed `%` escape in a path-parameter segment used to make
   * `decodeURIComponent` throw `URIError`, which `mapError` has no case
   * for and maps to 500 -- a client could 500 the dispatcher at will on
   * any route with a `{name}` segment. API-1b's own registry has no
   * `{name}` route yet, so this exercises `matchRoute` directly against
   * a synthetic one, the same way the `startsRun` test above exercises
   * `validateRegistry` against a synthetic `badRoute`. Fails on 002a5b6
   * with an uncaught URIError instead of returning null.
   */
  it('a malformed % escape in a {name} segment does not match -- no thrown URIError', () => {
    const paramRoute: RouteEntry = {
      method: 'GET',
      path: '/api/v1/test-only-runs/{id}',
      operationId: 'testOnlyGetRun',
      minRole: 'member',
      idempotency: 'never',
      responseSchema: z.object({ id: z.string() }),
      async handler(_ctx, input) {
        return { id: input.params.id as string };
      },
    };
    expect(() => matchRoute([paramRoute], 'GET', '/api/v1/test-only-runs/%E0%A4%A')).not.toThrow();
    expect(matchRoute([paramRoute], 'GET', '/api/v1/test-only-runs/%E0%A4%A')).toBeNull();
    // A well-formed escape still resolves normally.
    const ok = matchRoute([paramRoute], 'GET', '/api/v1/test-only-runs/abc%20def');
    expect(ok?.params.id).toBe('abc def');
  });

  it('an entry declaring no `principals` resolves to session-only', () => {
    const testOnlyEntry: Pick<RouteEntry, 'principals'> = {};
    expect(effectivePrincipals(testOnlyEntry)).toEqual(['session']);
  });

  it('a `startsRun: true` entry that lists `token` fails validateRegistry', () => {
    const badRoute: RouteEntry = {
      method: 'POST',
      path: '/api/v1/test-only-starts-run',
      operationId: 'testOnlyStartsRun',
      principals: ['session', 'token'],
      minRole: 'member',
      idempotency: 'required',
      startsRun: true,
      responseSchema: z.object({ ok: z.boolean() }),
      async handler() {
        return { ok: true };
      },
    };
    expect(() => validateRegistry([badRoute])).toThrow(/startsRun/);
  });

  it('the real registry passes its own validateRegistry invariant', () => {
    expect(() => validateRegistry(ROUTES)).not.toThrow();
  });
});
