import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAcceptanceScope, parseDerivedFileRules } from '@fulcrumaxe/runner-protocol';
import { describe, expect, it } from 'vitest';
import { DERIVED_FILE_RULES, DERIVED_FILE_TABLE } from '../../src/specs/derivedFileRules.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (rel: string): string => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

describe('this repository table of derived files (#751)', () => {
  it('is read whole by the parser, and is not empty', () => {
    expect(parseDerivedFileRules(DERIVED_FILE_TABLE)).not.toBeNull();
    expect(DERIVED_FILE_RULES.length).toBeGreaterThan(0);
  });

  it('is the same table the runner reads from the repository, .fulcrumaxe/derived-files.json', () => {
    expect(JSON.parse(read('.fulcrumaxe/derived-files.json'))).toEqual(DERIVED_FILE_TABLE);
  });

  it('names only paths that exist: every output, and the directory every input starts from', () => {
    for (const rule of DERIVED_FILE_RULES) {
      for (const out of rule.outputs) expect(existsSync(path.join(REPO_ROOT, out)), `${rule.id}: ${out}`).toBe(true);
      for (const input of rule.inputs) {
        const dir = input.split('/').filter((_, i, all) => !all.slice(0, i + 1).some((s) => s.includes('*'))).join('/');
        expect(existsSync(path.join(REPO_ROOT, dir)), `${rule.id}: ${dir}`).toBe(true);
      }
      expect(parseAcceptanceScope([...rule.inputs]).kind, rule.id).toBe('known');
    }
  });

  it('never lists a file that grants an exemption: no row-level-security exemption list or ops view allowlist beside a migration', () => {
    const outputs = DERIVED_FILE_RULES.flatMap((r) => [...r.outputs]);
    expect(outputs).not.toContain('packages/db/src/platformWideTables.ts');
    expect(outputs).not.toContain('packages/db/src/opsInventory.ts');
    expect(DERIVED_FILE_RULES.some((r) => r.inputs.some((i) => i.includes('migrations')))).toBe(false);
  });

  it('has the route rule name generator scripts that exist', () => {
    const route = DERIVED_FILE_RULES.find((r) => r.id === 'api-routes')!;
    expect(route.kind).toBe('generated');
    const scripts = (dir: string): Record<string, string> => (JSON.parse(read(`${dir}/package.json`)) as { scripts: Record<string, string> }).scripts;
    expect(scripts('packages/api')['gen-openapi']).toBeDefined();
    expect(scripts('packages/api-client')['gen']).toBeDefined();
    expect(route.generators).toEqual([['pnpm', '--filter', '@fx/api', 'gen-openapi'], ['pnpm', '--filter', '@fx/api-client', 'gen']]);
  });

  // The Gate 1 regeneration list is overlay (private-tree) only: it is absent on the public code plane, where this check cannot run.
  it.skipIf(!existsSync(path.join(REPO_ROOT, 'scripts/lib/gate1-regen-allowlist.json')))('has the route rule produce exactly the files the Gate 1 regeneration list rebuilds', () => {
    const list = JSON.parse(read('scripts/lib/gate1-regen-allowlist.json')) as { generated: string[] };
    const route = DERIVED_FILE_RULES.find((r) => r.id === 'api-routes')!;
    expect([...route.outputs].sort()).toEqual([...list.generated].sort());
  });
});
