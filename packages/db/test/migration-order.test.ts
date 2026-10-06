// D#94 criterion 7: a pure test, no database -- just the filenames and
// the README, so it runs as fast as every other file-shape check.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const README_PATH = path.join(__dirname, '..', 'migrations', 'README.md');

const sqlFiles = readdirSync(DEFAULT_MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));

describe('migration file naming (D#94 R1)', () => {
  it('has at least one migration file', () => {
    expect(sqlFiles.length).toBeGreaterThan(0);
  });

  it('every .sql name matches ^[0-9]{4}_[a-z0-9_]+\\.sql$', () => {
    const bad = sqlFiles.filter((f) => !/^[0-9]{4}_[a-z0-9_]+\.sql$/.test(f));
    expect(bad).toEqual([]);
  });

  it('every four-digit prefix is unique', () => {
    const prefixes = sqlFiles.map((f) => f.slice(0, 4));
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const p of prefixes) {
      if (seen.has(p)) duplicates.add(p);
      seen.add(p);
    }
    expect([...duplicates]).toEqual([]);
  });
});

describe('migrations/README.md (D#94)', () => {
  const readme = readFileSync(README_PATH, 'utf8');

  it('exists and documents the merge-monotonic rule', () => {
    expect(readme).toContain('merge-monotonic');
  });

  it('documents R1, R2 and R3', () => {
    expect(readme).toContain('R1');
    expect(readme).toContain('R2');
    expect(readme).toContain('R3');
  });

  it('references the replay audit script', () => {
    expect(readme).toContain('replay-merge-order.sh');
  });
});
