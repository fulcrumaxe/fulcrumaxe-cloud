import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROLE_NAMES, SITEKIT_ROLE_NAMES } from '@fx/roles';
import { applyCustomerOverride, assertRowMeetsFloor, meetsFloor } from '../src/floors.js';
import { ALL_ROUTABLE_ROLES } from '../src/roleUniverse.js';
import { DefaultTableFileSchema, validateRoutingRows } from '../src/tableSchema.js';
import type { RoutingRow } from '../src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]): string => readFileSync(path.join(here, '..', ...p), 'utf8');
const MIGRATIONS = path.join('..', '..', 'db', 'migrations');

const table = (): RoutingRow[] => DefaultTableFileSchema.parse(JSON.parse(read('default-table', 'v1.json'))).rows as RoutingRow[];

/** The (role, size, model, rationale) tuples of every `('role', 'Size', 'model', 'rationale')` row in a SQL seed, in order. */
function sqlRows(sql: string, withVersion: boolean): string[] {
  const re = withVersion
    ? /^\s*\(1, '([a-z-]+)', '(Small|Feature|Critical)', '([a-z0-9.-]+)', '([^']*)'\)/gm
    : /^\s*\('([a-z-]+)', '(Small|Feature|Critical)', '([a-z0-9.-]+)', '([^']*)'\)/gm;
  return [...sql.matchAll(re)].map((m) => `${m[1]}|${m[2]}|${m[3]}|${m[4]}`);
}

describe('the site-kit roles in the routing universe (D#2 C12 (b), (c))', () => {
  it('SITEKIT_ROLE_NAMES is exactly the two roles, and the hosted team still has 26', () => {
    expect([...SITEKIT_ROLE_NAMES]).toEqual(['site-extractor', 'site-verifier']);
    expect(ROLE_NAMES).toHaveLength(26);
  });

  it('ALL_ROUTABLE_ROLES has 28 unique entries', () => {
    expect(ALL_ROUTABLE_ROLES).toHaveLength(28);
    expect(new Set(ALL_ROUTABLE_ROLES).size).toBe(28);
  });
});

describe('the default table covers the site-kit rows (C12 (d))', () => {
  it('validateRoutingRows accepts v1.json', () => {
    expect(() => validateRoutingRows(table())).not.toThrow();
  });

  it('it fails when any one of the six new rows is removed', () => {
    const rows = table();
    const added = rows.filter((r) => SITEKIT_ROLE_NAMES.includes(r.role));
    expect(added).toHaveLength(6);
    for (const gone of added) {
      const without = rows.filter((r) => r !== gone);
      expect(() => validateRoutingRows(without), `${gone.role}/${gone.size}`).toThrow(/missing rows for/);
    }
  });

  it('the rows carry the ruled defaults', () => {
    const at = (role: string, size: string): string | undefined => table().find((r) => r.role === role && r.size === size)?.model;
    expect(['Small', 'Feature', 'Critical'].map((s) => at('site-extractor', s))).toEqual(['sonnet-5', 'sonnet-5', 'opus-5']);
    expect(['Small', 'Feature', 'Critical'].map((s) => at('site-verifier', s))).toEqual(['sonnet-5', 'opus-5', 'opus-5']);
  });
});

describe('the site verifier floor (C12 (f))', () => {
  it('a table row, and a customer override, on haiku-4.5 are refused with the security-reviewer errors', () => {
    expect(meetsFloor('site-verifier', 'haiku-4.5')).toBe(false);
    expect(meetsFloor('site-verifier', 'sonnet-5')).toBe(true);
    expect(() => assertRowMeetsFloor('site-verifier', 'haiku-4.5')).toThrow(/violates floor/);
    const tampered = table().map((r) => (r.role === 'site-verifier' && r.size === 'Small' ? { ...r, model: 'haiku-4.5' as const } : r));
    expect(() => validateRoutingRows(tampered)).toThrow(/violates floor/);
    expect(applyCustomerOverride('site-verifier', 'haiku-4.5')).toEqual({
      accepted: false,
      reason: '"haiku-4.5" is below the floor ("sonnet-5") for role "site-verifier"',
    });
  });

  it('the site extractor has no floor', () => {
    expect(meetsFloor('site-extractor', 'haiku-4.5')).toBe(true);
    expect(applyCustomerOverride('site-extractor', 'haiku-4.5')).toEqual({ accepted: true, model: 'haiku-4.5' });
  });
});

describe('v1.json equals the SQL seeds (C12 (g))', () => {
  it('the 0010 seed plus 1017 give exactly the rows of v1.json, in order', () => {
    const seed = [
      ...sqlRows(readFileSync(path.join(here, MIGRATIONS, '0010_model_routing.sql'), 'utf8'), true),
      ...sqlRows(readFileSync(path.join(here, MIGRATIONS, '1017_sitekit_role_routing.sql'), 'utf8'), false),
    ];
    const json = table().map((r) => `${r.role}|${r.size}|${r.model}|${r.rationale}`);
    expect(seed).toHaveLength(84);
    expect(json).toEqual(seed);
  });

  it('1017 targets only live and proposed versions and never overwrites a row', () => {
    const sql = readFileSync(path.join(here, MIGRATIONS, '1017_sitekit_role_routing.sql'), 'utf8');
    expect(sql).toMatch(/t\.status IN \('live', 'proposed'\)/);
    expect(sql).toMatch(/ON CONFLICT \(table_version, role, size\) DO NOTHING/);
  });
});
