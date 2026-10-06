import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WORK_ITEM_STAGES,
  WORK_ITEM_STAGE_TRANSITIONS,
  IllegalStageTransitionError,
  assertLegalStageTransition,
  isLegalStageTransition,
  type WorkItemStage,
} from '../../src/work-items/stages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * D#45 S1 criterion 3: `WORK_ITEM_STAGES` and `WORK_ITEM_STAGE_TRANSITIONS`
 * equal the Spec's tables exactly, as corrected by C1 (adds `closed ->
 * triaged` and `needs_human -> discussing`, 38 edges total instead of 36).
 * Both tables are written out literally here, independently of stages.ts's
 * own literal, so a typo in either file is caught by disagreement between
 * them.
 */
const EXPECTED_STAGES = [
  'triaged',
  'discussing',
  'spec_ready',
  'in_progress',
  'pr_opened',
  'changes_requested',
  'review_passed',
  'needs_human',
  'merged',
  'closed_unmerged',
  'closed',
] as const;

const EXPECTED_TRANSITIONS: Record<WorkItemStage, readonly WorkItemStage[]> = {
  triaged: ['discussing', 'spec_ready', 'in_progress', 'closed'],
  discussing: ['spec_ready', 'closed'],
  spec_ready: ['in_progress', 'closed'],
  in_progress: ['pr_opened', 'needs_human', 'closed'],
  pr_opened: ['changes_requested', 'review_passed', 'needs_human', 'merged', 'closed_unmerged'],
  changes_requested: ['changes_requested', 'review_passed', 'needs_human', 'merged', 'closed_unmerged'],
  review_passed: ['review_passed', 'changes_requested', 'needs_human', 'merged', 'closed_unmerged'],
  // C1: + 'discussing'.
  needs_human: [
    'in_progress',
    'pr_opened',
    'changes_requested',
    'review_passed',
    'merged',
    'closed_unmerged',
    'closed',
    'discussing',
  ],
  merged: ['closed'],
  closed_unmerged: ['in_progress', 'closed'],
  // C1: was [] ("(none)").
  closed: ['triaged'],
};

const EXPECTED_EDGE_COUNT = 38;

describe('WORK_ITEM_STAGES', () => {
  it('equals the Spec vocabulary exactly, in order', () => {
    expect(WORK_ITEM_STAGES).toEqual(EXPECTED_STAGES);
  });
});

describe('WORK_ITEM_STAGE_TRANSITIONS (D#45 Spec + Correction C1, 38 edges)', () => {
  it('equals the corrected table exactly', () => {
    expect(WORK_ITEM_STAGE_TRANSITIONS).toEqual(EXPECTED_TRANSITIONS);
  });

  it('has exactly 38 edges total', () => {
    const total = Object.values(EXPECTED_TRANSITIONS).reduce((sum, edges) => sum + edges.length, 0);
    expect(total).toBe(EXPECTED_EDGE_COUNT);
  });

  it('every inner array is frozen: push throws', () => {
    for (const stage of WORK_ITEM_STAGES) {
      expect(() => (WORK_ITEM_STAGE_TRANSITIONS[stage] as unknown as WorkItemStage[]).push('closed')).toThrow();
    }
  });

  it('the top-level table itself is frozen', () => {
    expect(() => {
      (WORK_ITEM_STAGE_TRANSITIONS as Record<string, readonly string[]>).bogus = [];
    }).toThrow();
  });
});

describe('assertLegalStageTransition / isLegalStageTransition: all 121 (from, to) pairs', () => {
  const legalPairs = new Set<string>();
  for (const from of WORK_ITEM_STAGES) {
    for (const to of EXPECTED_TRANSITIONS[from]) {
      legalPairs.add(`${from}->${to}`);
    }
  }

  it('the literal expected table itself has exactly 38 edges (sanity check on the fixture above)', () => {
    expect(legalPairs.size).toBe(EXPECTED_EDGE_COUNT);
  });

  for (const from of WORK_ITEM_STAGES) {
    for (const to of WORK_ITEM_STAGES) {
      const key = `${from}->${to}`;
      const legal = legalPairs.has(key);
      it(`${key} is ${legal ? 'legal' : 'illegal'}`, () => {
        expect(isLegalStageTransition(from, to)).toBe(legal);
        if (legal) {
          expect(() => assertLegalStageTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertLegalStageTransition(from, to)).toThrow(IllegalStageTransitionError);
        }
      });
    }
  }

  it('exactly 38 of the 121 pairs are legal', () => {
    expect(legalPairs.size).toBe(38);
    expect(WORK_ITEM_STAGES.length * WORK_ITEM_STAGES.length).toBe(121);
  });
});

describe('unknown "from" throws IllegalStageTransitionError, never a TypeError', () => {
  it.each(['bogus', '__proto__', 'constructor', 'toString'])('from = %s', (from) => {
    expect(() => assertLegalStageTransition(from, 'triaged')).toThrow(IllegalStageTransitionError);
    expect(isLegalStageTransition(from, 'triaged')).toBe(false);
  });
});

describe('Correction C1: the four added/changed test cases', () => {
  it('closed -> triaged is accepted (reopen)', () => {
    expect(isLegalStageTransition('closed', 'triaged')).toBe(true);
    expect(() => assertLegalStageTransition('closed', 'triaged')).not.toThrow();
  });

  it('needs_human -> discussing is accepted (escalation returns to the panel)', () => {
    expect(isLegalStageTransition('needs_human', 'discussing')).toBe(true);
    expect(() => assertLegalStageTransition('needs_human', 'discussing')).not.toThrow();
  });

  it('discussing -> merged is rejected', () => {
    expect(isLegalStageTransition('discussing', 'merged')).toBe(false);
    expect(() => assertLegalStageTransition('discussing', 'merged')).toThrow(IllegalStageTransitionError);
  });

  it('closed -> spec_ready is rejected (closed only reopens to triaged)', () => {
    expect(isLegalStageTransition('closed', 'spec_ready')).toBe(false);
    expect(() => assertLegalStageTransition('closed', 'spec_ready')).toThrow(IllegalStageTransitionError);
  });
});

/**
 * D#45 S1 criterion 10: "One writer." `INSERT INTO work_item_transitions`
 * (case-insensitive, any whitespace) may appear only in
 * packages/core/src/work-items/recordStage.ts, migration files, and test
 * files -- nowhere else under packages/** or apps/**.
 */
describe('one writer: INSERT INTO work_item_transitions appears only in recordStage.ts, migrations and tests', () => {
  const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
  const SCAN_ROOTS = ['packages', 'apps'];
  const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.sql']);
  const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.turbo', 'coverage', '.git']);
  const INSERT_PATTERN = /insert\s+into\s+work_item_transitions/i;
  const ALLOWED_SOURCE = path.join('packages', 'core', 'src', 'work-items', 'recordStage.ts');

  function isMigrationFile(relative: string): boolean {
    return /(^|\/)migrations\//.test(relative) && relative.endsWith('.sql');
  }

  function isTestFile(relative: string): boolean {
    return (
      /(^|\/)(test|tests)\//.test(relative) ||
      /\.(test|spec)\.[cm]?[jt]sx?$/.test(relative)
    );
  }

  function listFiles(dir: string): string[] {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue;
        out.push(...listFiles(full));
      } else if (SCAN_EXTENSIONS.has(path.extname(entry))) {
        out.push(full);
      }
    }
    return out;
  }

  const files = SCAN_ROOTS.flatMap((root) => listFiles(path.join(REPO_ROOT, root)));

  it('scanned at least the files this test knows about (guards against an empty/miscounted scan)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('the only non-migration, non-test file matching is recordStage.ts', () => {
    const matches = files
      .filter((file) => {
        const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
        if (isMigrationFile(relative) || isTestFile(relative)) return false;
        const contents = readFileSync(file, 'utf8');
        return INSERT_PATTERN.test(contents);
      })
      .map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'));
    expect(matches).toEqual([ALLOWED_SOURCE.split(path.sep).join('/')]);
  });

  it('the scan pattern actually catches a violation (proves it is not vacuous)', () => {
    expect('await client.query("  INSERT   INTO   work_item_transitions (id) VALUES ($1)")').toMatch(
      INSERT_PATTERN,
    );
    expect('insert into work_item_transitions').toMatch(INSERT_PATTERN);
  });
});
