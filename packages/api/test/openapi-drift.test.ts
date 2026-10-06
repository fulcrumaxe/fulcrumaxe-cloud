import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROUTES } from '../src/routes/index.js';
import { buildOpenApiDocument, serializeOpenApiDocument } from '../src/openapi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = path.join(__dirname, '..', 'openapi.json');

/**
 * D#31 API-1 criterion 1: "`pnpm --filter @fx/api gen-openapi` regenerates
 * `packages/api/openapi.json` byte for byte. The drift test fails when a
 * zod schema changes without regenerating." This recomputes the document
 * in memory through the exact same pair of calls `scripts/gen-openapi.ts`
 * uses (`buildOpenApiDocument` then `serializeOpenApiDocument` -- never a
 * bare `JSON.stringify` at either call site) and diffs it, as raw text,
 * against the committed file. `fs.readFileSync` (not a JSON import) is
 * deliberate: a JSON import loses trailing-newline/whitespace fidelity
 * that a byte-for-byte comparison needs.
 */
describe('openapi.json: no drift from the registry', () => {
  it('regenerating from the registry reproduces the committed file byte for byte', () => {
    const committed = readFileSync(OPENAPI_PATH, 'utf8');
    const regenerated = serializeOpenApiDocument(buildOpenApiDocument(ROUTES));
    expect(regenerated).toBe(committed);
  });

  it('declares openapi: 3.1.0', () => {
    const doc = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as { openapi: string };
    expect(doc.openapi).toBe('3.1.0');
  });

  it('every operation has an operationId', () => {
    const doc = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    for (const [pathKey, methods] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        expect(operation.operationId, `${method.toUpperCase()} ${pathKey} is missing operationId`).toBeTruthy();
      }
    }
  });

  it('every 4xx/5xx response references the shared Error schema', () => {
    const doc = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, { content?: Record<string, { schema?: unknown }> }> }>
      >;
    };
    for (const methods of Object.values(doc.paths)) {
      for (const operation of Object.values(methods)) {
        for (const [status, response] of Object.entries(operation.responses)) {
          if (!/^[45]/.test(status)) continue;
          const schema = response.content?.['application/json']?.schema;
          expect(schema, `status ${status} is missing a JSON schema`).toEqual({
            $ref: '#/components/schemas/Error',
          });
        }
      }
    }
  });

  /**
   * Fix round item 3 (code review of this PR): every operation's
   * `security` array names a scheme (`session`, `token`), but nothing
   * defined `components.securitySchemes` -- a dangling OpenAPI 3.1
   * reference. Fails on 98c1182: `getAccount`'s `security` references
   * `session` and `token`, and `doc.components.securitySchemes` is
   * `undefined` at that head, so `definedSchemes` is empty and the very
   * first referenced scheme name fails the `.has()` check below.
   */
  it('every security scheme referenced in an operation has a matching components.securitySchemes entry', () => {
    const doc = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as {
      paths: Record<string, Record<string, { security?: Record<string, unknown>[] }>>;
      components: { securitySchemes?: Record<string, unknown> };
    };
    const definedSchemes = new Set(Object.keys(doc.components.securitySchemes ?? {}));
    let referencedAny = false;
    for (const [pathKey, methods] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        for (const requirement of operation.security ?? []) {
          for (const schemeName of Object.keys(requirement)) {
            referencedAny = true;
            expect(
              definedSchemes.has(schemeName),
              `${method.toUpperCase()} ${pathKey} references undefined security scheme "${schemeName}"`,
            ).toBe(true);
          }
        }
      }
    }
    // Guards against a vacuous pass if every operation stopped declaring `security`.
    expect(referencedAny).toBe(true);
  });
});
