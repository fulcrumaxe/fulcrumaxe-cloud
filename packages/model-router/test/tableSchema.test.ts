import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DefaultTableFileSchema, validateRoutingRows } from '../src/tableSchema.js';
import { ALL_ROUTABLE_ROLES } from '../src/roleUniverse.js';
import type { RoutingRow } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(path.join(__dirname, '..', 'default-table', 'v1.json'), 'utf8');

describe('default-table/v1.json', () => {
  it('parses against the zod schema', () => {
    const parsed = DefaultTableFileSchema.parse(JSON.parse(raw));
    expect(parsed.rows.length).toBe(ALL_ROUTABLE_ROLES.length * 3);
  });

  it('validateRoutingRows accepts it: every (role, size) pair for all 26 roles is covered exactly once', () => {
    const parsed = DefaultTableFileSchema.parse(JSON.parse(raw));
    expect(() => validateRoutingRows(parsed.rows as RoutingRow[])).not.toThrow();
  });

  it('fails when a (role, size) pair is missing', () => {
    const parsed = DefaultTableFileSchema.parse(JSON.parse(raw));
    const withoutOne = parsed.rows.slice(1) as RoutingRow[];
    expect(() => validateRoutingRows(withoutOne)).toThrow(/missing rows for/);
  });

  it('fails when a table row puts security-reviewer below its floor', () => {
    const parsed = DefaultTableFileSchema.parse(JSON.parse(raw)).rows as RoutingRow[];
    const tampered = parsed.map((r) =>
      r.role === 'security-reviewer' && r.size === 'Small' ? { ...r, model: 'haiku-4.5' as const } : r,
    );
    expect(() => validateRoutingRows(tampered)).toThrow(/violates floor/);
  });

  it('fails on a duplicate (role, size) pair', () => {
    const parsed = DefaultTableFileSchema.parse(JSON.parse(raw)).rows as RoutingRow[];
    const duplicated = [...parsed, parsed[0] as RoutingRow];
    expect(() => validateRoutingRows(duplicated)).toThrow(/duplicate row/);
  });
});
