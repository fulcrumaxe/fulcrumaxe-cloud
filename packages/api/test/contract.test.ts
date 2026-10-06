import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { ROUTES } from '../src/routes/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = path.join(__dirname, '..', 'fixtures', 'v1');

/**
 * D#31 API-1 criterion 9: "contract.test.ts validates every fixture under
 * packages/api/fixtures/v1/** against its operation's response schema
 * (JSON Schema 2020-12). An in-test fixture with a wrong type fails."
 *
 * "Conventions" > Fixtures: "each task adds
 * packages/api/fixtures/v1/<operationId>/<status>-<name>.json." The
 * directory name IS the operationId, so this walks the fixtures tree once
 * and looks up each operation's `responseSchema` from the registry by
 * that name -- no separate mapping to keep in sync.
 */
const ajv = new Ajv2020({ strict: false });
const errorSchema = JSON.parse(readFileSync(path.join(__dirname, '..', 'openapi.json'), 'utf8')).components.schemas.Error;
const validateError = ajv.compile(errorSchema);

function operationDirs(): string[] {
  try {
    return readdirSync(FIXTURES_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

describe('contract: every fixture validates against its operation response schema', () => {
  const dirs = operationDirs();

  for (const operationId of dirs) {
    const entry = ROUTES.find((r) => r.operationId === operationId);

    it(`${operationId}: fixture directory maps to a real registry entry`, () => {
      expect(entry, `no ROUTES entry has operationId "${operationId}"`).toBeDefined();
    });

    if (!entry) continue;

    const dir = path.join(FIXTURES_ROOT, operationId);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const jsonSchema = z.toJSONSchema(entry.responseSchema, { target: 'draft-2020-12' });
    const validate = ajv.compile(jsonSchema);

    for (const file of files) {
      // A 4xx/5xx fixture is an error response: it validates against the published Error schema.
      const check = /^[45]\d\d-/.test(file) ? validateError : validate;
      it(`${operationId}/${file} validates against its response schema`, () => {
        const data = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
        const valid = check(data);
        expect(valid, ajv.errorsText(check.errors)).toBe(true);
      });
    }
  }

  /**
   * D#31 API-1b: no route ships in this task -- `GET /api/v1/account` and
   * its fixture are API-1c's -- so `packages/api/fixtures/v1/**` is empty
   * here and the loop above runs zero times. That is correct (there is
   * nothing to validate yet), not the "vacuously empty" failure mode
   * criterion 9 guards against: what still has to be proven, with no real
   * operation to reach for, is that the validator itself (ajv compiling a
   * zod-derived JSON Schema 2020-12 document) actually rejects a
   * wrong-shape payload. This test proves that against a schema local to
   * the test file, the same way `inventory.test.ts` proves
   * `validateRegistry` against a synthetic `badRoute` rather than a real
   * one. When API-1c adds `getAccount` (and every later task adds its own
   * operation), the loop above starts exercising real fixtures with no
   * change required to this file.
   */
  it('the validator rejects a fixture whose shape does not match its schema (not vacuous)', () => {
    const responseSchema = z.object({ id: z.string().uuid(), plan: z.string(), status: z.string() });
    const jsonSchema = z.toJSONSchema(responseSchema, { target: 'draft-2020-12' });
    const validate = ajv.compile(jsonSchema);
    const goodFixture = { id: '00000000-0000-0000-0000-000000000000', plan: 'starter', status: 'active' };
    // `id` must be a uuid string; this sends a number instead.
    const badFixture = { id: 12345, plan: 'starter', status: 'active' };
    expect(validate(goodFixture)).toBe(true);
    expect(validate(badFixture)).toBe(false);
  });
});
