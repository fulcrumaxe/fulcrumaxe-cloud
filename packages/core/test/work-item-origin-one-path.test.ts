import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * D#483 S4e3-5: the reader is the one path. A statement that joins `proposals` to `work_items` and also names
 * `provenance` is how the two provenances get confused (the proposal keeps `external`, the item it makes is `internal`),
 * so outside the reader's module and its tests none may exist in packages/, except the entry listed below.
 *
 * Allowed, and why: the worker's advance step has one statement that reads the work item's own provenance for the review gate
 * and joins the proposal only for its title and summary. That is not a learning read. Only that statement is allowed (matched
 * by its own text), so a learning join added later in the same file is still caught.
 */
const PACKAGES = resolve(__dirname, '../..');
const READER = join('core', 'src', 'plan', 'workItemOrigin.ts');
const ALLOWED = new Map<string, RegExp>([[join('worker', 'src', 'advance.ts'), /SELECT w\.stage, w\.provenance, w\.repo_id,/]]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.next' || name === 'test' || name === 'tests') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\./.test(name) && name !== 'generated.ts') out.push(p);
  }
  return out;
}

/** Every string or template literal in a source that joins the two tables and names provenance. */
function offendingLiterals(source: string): string[] {
  const literals = source.match(/`[^`]*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g) ?? [];
  return literals.filter((l) => /\bproposals\b/i.test(l) && /\bwork_items\b/i.test(l) && /provenance/i.test(l));
}

describe('workItemOrigin is the one path (S4e3-5)', () => {
  it('no other file in packages/ joins proposals to work_items to read provenance', () => {
    const offenders = walk(PACKAGES)
      .map((f) => relative(PACKAGES, f))
      .filter((rel) => rel !== READER)
      .filter((rel) => {
        const allowedStatement = ALLOWED.get(rel);
        return offendingLiterals(readFileSync(join(PACKAGES, rel), 'utf8')).filter((l) => !allowedStatement?.test(l)).length > 0;
      });
    expect(offenders).toEqual([]);
  });

  it('the scan really sees such a statement: the allowed entry is a hit, so it cannot pass by finding nothing', () => {
    for (const [file, statement] of ALLOWED) {
      const hits = offendingLiterals(readFileSync(join(PACKAGES, file), 'utf8'));
      expect(hits.filter((l) => statement.test(l))).toHaveLength(1);
    }
  });

  it('flags the join in either order and leaves a proposal-only read alone', () => {
    expect(offendingLiterals('const q = `SELECT w.provenance FROM work_items w JOIN proposals p ON p.work_item_id = w.id`;')).toHaveLength(1);
    expect(offendingLiterals('const q = `SELECT p.id FROM proposals p JOIN work_items w ON w.id = p.work_item_id WHERE w.provenance = $1`;')).toHaveLength(1);
    expect(offendingLiterals('const q = `SELECT p.provenance FROM proposals p WHERE p.work_item_id = $1`;')).toHaveLength(0);
  });

  it('the allowance is one statement, not the file: a second learning join in the same file would be flagged', () => {
    const [file, statement] = [...ALLOWED][0]!;
    const source = readFileSync(join(PACKAGES, file), 'utf8') + '\nconst extra = `SELECT p.id FROM proposals p JOIN work_items w ON w.id = p.work_item_id WHERE w.provenance = $1`;';
    expect(offendingLiterals(source).filter((l) => !statement.test(l))).toHaveLength(1);
  });

  it('the reader module never names the work_items table', () => {
    const text = readFileSync(join(PACKAGES, READER), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(text).not.toMatch(/work_items/);
  });
});
