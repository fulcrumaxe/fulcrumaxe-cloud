import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * D#575 criterion 5: scripts/check-agent-run-columns.sh fails on a star select
 * over agent_runs. Each of the three shapes has a positive fixture (the scan
 * must fail, naming the file and the rule) and a negative one (it must pass).
 * The fixtures are written to a temp directory and scanned with --root, so the
 * scan is exercised against known text, not against whatever the repo holds.
 */
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'check-agent-run-columns.sh');
const dirs: string[] = [];

function scan(source: string): { status: number | null; out: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tam-scan-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'q.ts'), source);
  const r = spawnSync('bash', [SCRIPT, '--root', dir], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const sql = (text: string) => `export const q = \`${text}\`;\n`;

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('check-agent-run-columns: shape 1, agent_runs.*', () => {
  it('positive: agent_runs.* fails', () => {
    const r = scan(sql('SELECT agent_runs.* FROM agent_runs WHERE id = $1'));
    expect(r.status).toBe(1);
    expect(r.out).toContain('src/q.ts:1: agent_runs.* (qualified star)');
  });
  it('negative: a named column of agent_runs passes', () => {
    expect(scan(sql('SELECT agent_runs.id, agent_runs.status FROM agent_runs')).status).toBe(0);
  });
});

describe('check-agent-run-columns: shape 2, alias.* over agent_runs', () => {
  it('positive: a mixed select list ending in r.* fails', () => {
    const r = scan(sql('SELECT w.id, r.* FROM work_items w JOIN agent_runs r ON r.work_item_id = w.id'));
    expect(r.status).toBe(1);
    expect(r.out).toContain('r.* (alias of agent_runs)');
  });
  it('positive: AS alias and a comma join are caught too', () => {
    expect(scan(sql('SELECT x.* FROM agent_runs AS x')).status).toBe(1);
    expect(scan(sql('SELECT w.id, ar.* FROM work_items w, agent_runs ar WHERE ar.work_item_id = w.id')).status).toBe(1);
  });
  it('positive: RETURNING r.* on an aliased update fails', () => {
    expect(scan(sql('UPDATE agent_runs r SET status = $2 WHERE r.id = $1 RETURNING r.*')).status).toBe(1);
  });
  it("negative: another table's alias.* in a join with agent_runs passes", () => {
    expect(scan(sql('SELECT w.*, r.id AS run_id FROM work_items w JOIN agent_runs r ON r.work_item_id = w.id')).status).toBe(0);
  });
});

describe('check-agent-run-columns: shape 3, bare * and RETURNING *', () => {
  it('positive: SELECT * FROM agent_runs fails', () => {
    const r = scan(sql('SELECT * FROM agent_runs WHERE id = $1'));
    expect(r.status).toBe(1);
    expect(r.out).toContain('bare * select over agent_runs');
  });
  it('positive: a star select over a join that names agent_runs fails', () => {
    expect(scan(sql('SELECT * FROM work_items w JOIN agent_runs r ON r.work_item_id = w.id')).status).toBe(1);
    expect(scan(sql('SELECT w.id, * FROM work_items w LEFT JOIN public.agent_runs r ON r.work_item_id = w.id')).status).toBe(1);
  });
  it('positive: RETURNING * on UPDATE and INSERT into agent_runs fails', () => {
    const upd = scan(sql('UPDATE agent_runs SET status = $2 WHERE id = $1 RETURNING *'));
    expect(upd.status).toBe(1);
    expect(upd.out).toContain('RETURNING * on agent_runs');
    expect(scan(sql('INSERT INTO agent_runs (id, role) VALUES ($1, $2) RETURNING *')).status).toBe(1);
  });
  it('positive: a quoted, schema-qualified and interpolated statement is still caught', () => {
    expect(scan("export const q = 'select * from \"agent_runs\" where id = $1';\n").status).toBe(1);
    expect(scan('export const q = `SELECT * FROM ${schema}.agent_runs`;\n').status).toBe(1);
  });
  it('negative: count(*), a named list and RETURNING of named columns pass', () => {
    expect(scan(sql('SELECT count(*) FROM agent_runs WHERE status = $1')).status).toBe(0);
    expect(scan(sql('SELECT id, status FROM agent_runs WHERE id = $1')).status).toBe(0);
    expect(scan(sql('UPDATE agent_runs SET status = $2 WHERE id = $1 RETURNING id, status')).status).toBe(0);
  });
  it('negative: a star over another table with agent_runs only in a subquery passes', () => {
    expect(scan(sql('SELECT * FROM work_items w WHERE EXISTS (SELECT 1 FROM agent_runs r WHERE r.work_item_id = w.id)')).status).toBe(0);
    expect(scan(sql('UPDATE work_items SET status = $2 WHERE id = $1 RETURNING *')).status).toBe(0);
  });
  it('negative: a star mentioned only in a comment passes, and an allow marker passes', () => {
    expect(scan('// SELECT * FROM agent_runs is refused\nexport const q = 1;\n').status).toBe(0);
    expect(scan(sql('SELECT * FROM agent_runs /* agent-run-columns: allow admin connection */')).status).toBe(0);
  });
});

describe('check-agent-run-columns: the repository', () => {
  it('is clean', () => {
    const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8' });
    expect(`${r.stdout}${r.stderr}`).toContain('ok');
    expect(r.status).toBe(0);
  });
  it('exits 2 for a missing --root', () => {
    expect(spawnSync('bash', [SCRIPT, '--root', '/nonexistent-tam-dir'], { encoding: 'utf8' }).status).toBe(2);
  });
});
