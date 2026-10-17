import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { ASK_PROCEEDED_OUTCOME, sweepOverdueAsks } from '../src/decisions/index.js';

/** DP12a-2 without a database: the call shape, the "never throws" rule, and the source rules R1 and DP-C9 set. */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '../src/decisions/sweepOverdue.ts'), 'utf8');
const migration = readFileSync(join(here, '../../db/migrations/0853_decision_ask_timeout.sql'), 'utf8');
/** The text of the file without its comments, so a rule is checked against code and not against prose. */
const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*--.*$/gm, '');

describe('sweepOverdueAsks without a database', () => {
  it('lists with the clock\'s time and the limit, and an empty list is an empty result', async () => {
    const calls: unknown[][] = [];
    const pool = { query: async (_sql: string, args: unknown[]) => { calls.push(args); return { rows: [] }; } } as unknown as Pool;
    const at = new Date('2026-10-16T12:00:00Z');
    expect(await sweepOverdueAsks(pool, { now: () => at }, 7)).toEqual({ overdue: 0, proceeded: 0, skipped: 0, failed: 0, proceededAskIds: [] });
    expect(calls).toEqual([[at, 7]]);
  });

  it('a list that fails is counted as failed and never thrown, and the error text is not kept', async () => {
    const pool = { query: async () => { throw new Error('connect ECONNREFUSED db.internal:5432'); } } as unknown as Pool;
    const res = await sweepOverdueAsks(pool, { now: () => new Date() }, 5);
    expect(res.failed).toBe(1);
    expect(JSON.stringify(res)).not.toContain('db.internal');
  });

  it('names the outcome DP-C5 gives a policy receipt', () => {
    expect(ASK_PROCEEDED_OUTCOME).toBe('proceeded_without_answer');
  });
});

describe('what the sweep may not do (R1, DP-C9 section 6)', () => {
  it('its TypeScript never names the answered state, a denial, or a run-action request', () => {
    const c = code(source);
    expect(c).not.toMatch(/'answered'|"answered"/);
    expect(c).not.toMatch(/decision_denied|decision_resolved|'deny'.*chosen|run_action_request|resume_decision/);
  });

  it('its definer never sets answered or answered_by, never touches run_action_requests, and claims with SKIP LOCKED', () => {
    const c = code(migration);
    expect(c).not.toMatch(/state\s*=\s*'answered'|answered_by\s*=|run_action_request|resume_decision|decision_denied/);
    expect(c).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(c).toMatch(/AND a\.state = 'open' AND a\.answer_due_at <= p_now/);
  });

  it('it proceeds only after the three safety conditions, in the code and not by comment', () => {
    const c = code(source);
    expect(c).toMatch(/entry\.timeoutOutcomes\.includes\('proceed_recommended'\)/);
    expect(c).toMatch(/ask\.run_id !== null/);
    expect(c).toMatch(/ask\.options\.some\(\(o\) => o\.id === ask\.proposed\)/);
  });
});
