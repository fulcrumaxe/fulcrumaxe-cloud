import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_PROPOSABLE_KINDS } from '../../src/setup-requests/kinds.js';

/**
 * D#598 P1g-3a (R-597-1, R-C27-2): only a person's own click answers "someone pushed to the public branch". No worker, model, agent or pipeline path may keep,
 * replace or release a branch, or raise the request as a model proposal. The three answer functions and the file that wraps them are referenced only by the
 * core files that define them and by the HTTP routes (session only, owner or admin). Anything else that names them fails here, so a new caller has to be a
 * reviewed change to this list.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const NAMES = /\b(keepBranchPushedByPerson|replaceBranchPushedByPerson|releaseManagedBranch|branchPushedAnswer|keepBranch|replaceBranch|releaseBranch)\b/;
/** Every file allowed to name them, with the reason. */
const ALLOWED = new Map<string, string>([
  ['packages/core/src/setup-requests/branchPushed.ts', 'defines Keep, Replace and the undo'],
  ['packages/core/src/setup-requests/branchPushedAnswer.ts', 'wraps them for the person\'s session'],
  ['packages/api/src/routes/setupRequests.ts', 'the session-only owner-or-admin routes'],
]);
/**
 * The columns a person's answer sets. Setting one to a value is what makes the platform hold, follow or overwrite a public branch, so only the answer
 * definitions may do it; every path may CLEAR them (the update that lands, a refused round, the branch put back). Three shapes of write are matched:
 * an UPDATE's `SET col = value`, a tuple `SET (a, col) = (x, y)` (unless every value is NULL), and an INSERT whose column list names one.
 */
const WRITERS = new Map<string, string>([['packages/core/src/setup-requests/branchPushed.ts', 'defines Keep, Replace and the undo, the only writers of these columns']]);
const COLUMNS = '(?:replace_authorized_head|managed_by_person_at|answered_request_id|kept_head)';
const NON_NULL_WRITE = new RegExp(`\\bSET\\b[\\s\\S]{0,300}?\\b${COLUMNS}\\s*=(?!=)(?!\\s*null\\b)`, 'i');
const TUPLE_WRITE = new RegExp(`\\bSET\\b[\\s\\S]{0,300}?\\([^()]*\\b${COLUMNS}\\b[^()]*\\)\\s*=\\s*\\((?!\\s*null\\s*(?:,\\s*null\\s*)*\\))`, 'i');
const INSERT_WRITE = new RegExp(`\\bINSERT\\s+INTO\\s+[\\w."]+\\s*\\([^)]*\\b${COLUMNS}\\b[^)]*\\)`, 'i');
const writesAnswerColumns = (text: string): boolean => NON_NULL_WRITE.test(text) || TUPLE_WRITE.test(text) || INSERT_WRITE.test(text);

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', '.next', 'test', 'tests', 'e2e', '.turbo', 'coverage'].includes(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* sources(full);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name) && !/\.(test|spec)\./.test(name)) yield full;
  }
}

describe('only a person answers a branch someone pushed to (R-597-1)', () => {
  it('no source file outside the definitions and the routes names Keep, Replace or the undo', () => {
    const found: string[] = [];
    for (const top of ['packages', 'apps']) {
      for (const pkg of readdirSync(join(ROOT, top))) {
        const base = join(ROOT, top, pkg);
        if (!statSync(base).isDirectory()) continue;
        for (const file of sources(base)) {
          const rel = relative(ROOT, file).split(sep).join('/');
          if (ALLOWED.has(rel)) continue;
          if (NAMES.test(readFileSync(file, 'utf8'))) found.push(rel);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('the allowed files still exist (a rename cannot quietly widen the scan)', () => {
    for (const rel of [...ALLOWED.keys(), ...WRITERS.keys()]) expect(statSync(join(ROOT, rel)).isFile()).toBe(true);
  });

  it('no source file but the answer definitions SETS the authorization, the managed mark or the answered request to a value (clearing them to NULL is open to every path)', () => {
    const found: string[] = [];
    for (const top of ['packages', 'apps']) {
      for (const pkg of readdirSync(join(ROOT, top))) {
        const base = join(ROOT, top, pkg);
        if (!statSync(base).isDirectory()) continue;
        for (const file of sources(base)) {
          const rel = relative(ROOT, file).split(sep).join('/');
          if (WRITERS.has(rel)) continue;
          if (writesAnswerColumns(readFileSync(file, 'utf8'))) found.push(rel);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('the write scan catches the shapes it exists for', () => {
    for (const bad of [
      "UPDATE plane_pushes SET replace_authorized_head = $2 WHERE id = $1",
      "UPDATE plane_pushes SET state = 'pr_opened', replace_authorized_head = $2 WHERE id = $1",
      'UPDATE plane_pushes SET managed_by_person_at = now() WHERE id = $1',
      "UPDATE plane_pushes p SET head_sha = $1, answered_request_id = $2::uuid WHERE id = $3",
      "UPDATE plane_pushes SET kept_head = $2 WHERE id = $1",
      'UPDATE plane_pushes SET (head_sha, replace_authorized_head) = ($1, $2) WHERE id = $3',
      'UPDATE plane_pushes SET (managed_by_person_at, answered_request_id) = (now(), $2::uuid) WHERE id = $1',
      'UPDATE plane_pushes SET (state, managed_by_person_at) = (\'pr_opened\', NULL), (kept_head) = ($2) WHERE id = $1',
      'INSERT INTO plane_pushes (account_id, work_item_id, managed_by_person_at) VALUES ($1, $2, now())',
      'INSERT INTO "plane_pushes" (id, replace_authorized_head, state) VALUES ($1, $2, \'pr_opened\')',
    ]) expect(writesAnswerColumns(bad), bad).toBe(true);
    for (const fine of [
      'UPDATE plane_pushes SET head_sha = $3, replace_authorized_head = NULL WHERE id = $1',
      'UPDATE plane_pushes SET managed_by_person_at = NULL, answered_request_id = NULL WHERE id = $1',
      'SELECT 1 FROM plane_pushes WHERE replace_authorized_head = $1',
      "typeof push.replace_authorized_head === 'string' ? push.replace_authorized_head : null",
      'UPDATE plane_pushes SET (replace_authorized_head, answered_request_id) = (NULL, NULL) WHERE id = $1',
      'UPDATE plane_pushes SET (head_sha, tip_sha) = ($1, $2) WHERE id = $3',
      'INSERT INTO plane_pushes (account_id, work_item_id, head_sha) VALUES ($1, $2, $3)',
      'UPDATE plane_pushes SET kept_head = NULL WHERE work_item_id = $1',
    ]) expect(writesAnswerColumns(fine), fine).toBe(false);
  });

  it('a model cannot propose the request: it is not in the proposable kinds', () => {
    expect((AGENT_PROPOSABLE_KINDS as readonly string[]).includes('branch_pushed_by_person')).toBe(false);
  });
});
