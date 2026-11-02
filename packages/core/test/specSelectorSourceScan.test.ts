import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D#483 S5-b2d-2b-0 (C29-0-1): `specOfItemSql` (work-items/stages.ts) is the only text that turns "this item" into "its Spec versions". A raw
 * `planned_pr_key IS NULL` selector, or the pinned arm of a CASE (`ELSE <alias>.id = <item>.planned_pr_spec_version_id`), in any other product source file fails here, so a new consumer cannot
 * quietly read the wrong Spec for a follow-up child (whose pin is NULL and whose key is not in any parent table).
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HOME = 'packages/core/src/work-items/stages.ts';
const RAW_OWN_SELECTOR = /planned_pr_key\s+IS\s+NULL\s+THEN\s+\w+\.work_item_id/i;
// Any comparison of a Spec row id with an item's pin, in either operand order and in either arm of a CASE.
const RAW_PIN_SELECTOR = /\b\w+\.id\s*=\s*\w+\.planned_pr_spec_version_id|\b\w+\.planned_pr_spec_version_id\s*=\s*\w+\.id/i;
// Planned-only readers that legitimately compare against the pin. buildIdentity.ts: the `key_in_table` subquery of check 4, which runs only for a planned child (the follow-up
// branch is taken before it is used). Add a file here only with a reason.
const PIN_ALLOWLIST = new Set(['packages/core/src/work-items/buildIdentity.ts']);

function findRawSelectors(file: string, text: string): string[] {
  if (file === HOME) return [];
  return [RAW_OWN_SELECTOR, ...(PIN_ALLOWLIST.has(file) ? [] : [RAW_PIN_SELECTOR])].filter((re) => re.test(text)).map((re) => `${file}: ${re.source}`);
}

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.next') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

describe('the one Spec selector (D#483 S5-b2d-2b-0)', () => {
  it('no product source outside stages.ts holds its own copy of the selector', () => {
    const roots = ['packages', 'apps'].map((r) => path.join(ROOT, r));
    const found = roots.flatMap((r) => sources(r)).flatMap((f) => findRawSelectors(path.relative(ROOT, f).split(path.sep).join('/'), readFileSync(f, 'utf8')));
    expect(found).toEqual([]);
  });

  it('the scan sees both raw forms and exempts only the home file', () => {
    const own = 'WHERE (CASE WHEN w.planned_pr_key IS NULL THEN s.work_item_id = w.id ELSE 1 END)';
    const pin = 'ELSE sv.id = w.planned_pr_spec_version_id AND sv.work_item_id = w.parent_id END';
    expect(findRawSelectors('packages/x/src/a.ts', own)).toHaveLength(1);
    expect(findRawSelectors('packages/x/src/a.ts', pin)).toHaveLength(1);
    const swapped = 'CASE WHEN w.follow_up_id IS NULL AND w.planned_pr_key IS NOT NULL THEN sv.id = w.planned_pr_spec_version_id AND sv.work_item_id = w.parent_id ELSE sv.work_item_id = w.id END';
    expect(findRawSelectors('packages/x/src/a.ts', swapped)).toHaveLength(1);
    expect(findRawSelectors('packages/x/src/a.ts', 'WHERE w.planned_pr_spec_version_id = sv.id')).toHaveLength(1);
    expect(findRawSelectors('packages/core/src/work-items/buildIdentity.ts', swapped)).toEqual([]);
    expect(findRawSelectors(HOME, own + pin)).toEqual([]);
    expect(findRawSelectors('packages/x/src/a.ts', 'CASE WHEN w.planned_pr_key IS NULL THEN d.kind ELSE w.kind END')).toEqual([]);
  });
});
