import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applySettingsPatch, DEFAULT_VERIFY_SETTINGS, isEligible, parseBaseUrl, type VerifySettings } from '../src/verify/settings.js';
import { canMove, FINISHED_STATUSES, GATE_METHODS, nextStreak, ROW_MOVES, streakOf, VERIFY_METHODS, VERIFY_REASON_CODES, VERIFY_ROW_STATUSES, type StreakInput, type VerifyRowStatus } from '../src/verify/rows.js';

const MIGRATION = readFileSync(path.join(__dirname, '..', '..', 'db', 'migrations', '1003_verify_stage.sql'), 'utf8');
// The reason check was last replaced by 1010 (one more word); the status and method checks are 1003's.
const LATER_MIGRATION = readFileSync(path.join(__dirname, '..', '..', 'db', 'migrations', '1010_verify_visible_criteria.sql'), 'utf8');
const listIn = (constraint: string): string[] => {
  const source = constraint === 'verify_rows_reason_check' ? LATER_MIGRATION : MIGRATION;
  const m = new RegExp(`${constraint} CHECK \\((?:status|method|reason_code) IN \\(([^)]*)\\)\\)`).exec(source);
  return [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
};

describe('the lists in code are the lists the table accepts', () => {
  it('statuses, methods and reasons', () => {
    expect(listIn('verify_rows_status_check')).toEqual([...VERIFY_ROW_STATUSES]);
    expect(listIn('verify_rows_method_check')).toEqual([...VERIFY_METHODS]);
    expect(listIn('verify_rows_reason_check')).toEqual([...VERIFY_REASON_CODES]);
  });
  it('the table\'s trigger lists the same moves as ROW_MOVES', () => {
    const trigger = MIGRATION.slice(MIGRATION.indexOf('IF NOT ((OLD.status'), MIGRATION.indexOf('RAISE EXCEPTION \'verify_rows: % -> %'));
    const fromSql: Record<string, string[]> = {};
    for (const m of trigger.matchAll(/OLD\.status = '([a-z]+)' AND NEW\.status IN \(([^)]*)\)/g)) fromSql[m[1]!] = [...m[2]!.matchAll(/'([a-z]+)'/g)].map((x) => x[1]!).filter((s) => s !== m[1]);
    for (const from of VERIFY_ROW_STATUSES) expect(fromSql[from] ?? [], from).toEqual([...ROW_MOVES[from]]);
  });
});

describe('the row state machine', () => {
  it('only moves forward, and a finished row has no move', () => {
    for (const from of VERIFY_ROW_STATUSES) for (const to of VERIFY_ROW_STATUSES) expect(canMove(from, to), `${from} -> ${to}`).toBe(ROW_MOVES[from].includes(to));
    for (const done of FINISHED_STATUSES) expect(ROW_MOVES[done]).toEqual([]);
    expect(canMove('pending', 'running')).toBe(false);
    expect(canMove('pending', 'verified')).toBe(false);
    expect(canMove('deploying', 'failed')).toBe(false);
    expect(canMove('running', 'pending')).toBe(false);
    expect(canMove('pending', 'unverified')).toBe(true);
    expect(canMove('deploying', 'unverified')).toBe(true);
    expect(canMove('running', 'unverified')).toBe(true);
  });
});

describe('the streak rule', () => {
  const clean: StreakInput = { status: 'verified', method: 'chrome_runner', mergedByProduct: true, deployByOrder: true, personStep: false, criterionPassed: true };
  it('counts a clean, self-verified merge', () => {
    expect(nextStreak(0, clean)).toBe(1);
    expect(nextStreak(2, clean)).toBe(3);
  });
  it('resets on a failed row and on an unverified row', () => {
    for (const status of ['failed', 'unverified'] as const) expect(nextStreak(2, { ...clean, status }), status).toBe(0);
  });
  it('resets on a person step, however the row ended', () => {
    for (const status of ['verified', 'failed', 'unverified'] as const) expect(nextStreak(2, { ...clean, status, personStep: true }), status).toBe(0);
  });
  it('is not touched by a merge the product did not make', () => {
    for (const status of ['verified', 'failed', 'unverified'] as const) expect(nextStreak(2, { ...clean, status, mergedByProduct: false }), status).toBe(2);
    expect(nextStreak(2, { ...clean, mergedByProduct: false, personStep: true })).toBe(2);
  });
  it('a verified row deployed by someone else resets (that deploy was a person step)', () => {
    expect(nextStreak(2, { ...clean, deployByOrder: false })).toBe(0);
  });
  it('a verified playwright_runner row counts', () => {
    expect(nextStreak(2, { ...clean, method: 'playwright_runner' })).toBe(3);
    expect(GATE_METHODS).toContain('playwright_runner');
  });
  it('a verified playwright_sandbox row or a null method neither counts nor resets', () => {
    for (const method of ['playwright_sandbox', null] as const) expect(nextStreak(2, { ...clean, method }), String(method)).toBe(2);
  });
  it('a failed or unverified playwright_runner row resets, and a person-deployed one resets', () => {
    const pw = { ...clean, method: 'playwright_runner' as const };
    for (const status of ['failed', 'unverified'] as const) expect(nextStreak(2, { ...pw, status }), status).toBe(0);
    expect(nextStreak(2, { ...pw, deployByOrder: false })).toBe(0);
  });
  it('a mixed chrome_runner then playwright_runner sequence counts both', () => {
    expect(streakOf([clean, { ...clean, method: 'playwright_runner' }])).toBe(2);
    expect(streakOf([clean, { ...clean, method: 'playwright_runner' }, { ...clean, method: 'playwright_sandbox' }, { ...clean, method: 'playwright_runner' }])).toBe(3);
  });
  it('a row that has not finished changes nothing', () => {
    for (const status of ['pending', 'deploying', 'running'] as VerifyRowStatus[]) expect(nextStreak(2, { ...clean, status }), status).toBe(2);
  });
  it('streakOf folds in order: the reset position matters', () => {
    const v = clean;
    const f = { ...clean, status: 'failed' as const };
    expect(streakOf([])).toBe(0);
    expect(streakOf([v, v, v])).toBe(3);
    expect(streakOf([v, v, f, v])).toBe(1);
    expect(streakOf([v, f, v, v])).toBe(2);
    expect(streakOf([v, v, v, f])).toBe(0);
  });
});

describe('eligibility', () => {
  it('all checks everything, including a merge whose paths are known to be elsewhere', () => {
    expect(isEligible({ eligibility: 'all', eligibilityPaths: [] }, ['docs/a.md'])).toBe(true);
    expect(isEligible({ eligibility: 'all', eligibilityPaths: [] }, null)).toBe(true);
  });
  it('ui_paths checks a merge that touched a configured directory, by whole segment', () => {
    const s = { eligibility: 'ui_paths' as const, eligibilityPaths: ['apps/web', 'packages/ui/'] };
    expect(isEligible(s, ['apps/web/page.tsx'])).toBe(true);
    expect(isEligible(s, ['apps/web'])).toBe(true);
    expect(isEligible(s, ['packages/ui/button.tsx'])).toBe(true);
    expect(isEligible(s, ['apps/website/page.tsx'])).toBe(false);
    expect(isEligible(s, ['docs/a.md', 'packages/db/x.sql'])).toBe(false);
    expect(isEligible(s, [])).toBe(false);
  });
  it('ui_paths with no configured path checks nothing it can see, but still checks a merge whose paths are unknown', () => {
    expect(isEligible({ eligibility: 'ui_paths', eligibilityPaths: [] }, ['apps/web/page.tsx'])).toBe(false);
    expect(isEligible({ eligibility: 'ui_paths', eligibilityPaths: [] }, null)).toBe(true);
  });
});

describe('settings values', () => {
  const current: VerifySettings = { repoId: 'r', ...DEFAULT_VERIFY_SETTINGS };
  it('the defaults are off', () => {
    expect(current).toMatchObject({ enabled: false, configured: false, baseUrl: null, eligibility: 'ui_paths', batchSize: 1, batchWindowMinutes: null, deployMode: 'runner_command' });
  });
  it('parseBaseUrl keeps an https origin and refuses everything else', () => {
    expect(parseBaseUrl('https://app.example')).toBe('https://app.example');
    expect(parseBaseUrl(' https://app.example/ ')).toBe('https://app.example');
    const bad = ['http://app.example', 'https://app.example/a', 'https://u@app.example', 'https://app.example?q', 'https://app.example#f', 'mailto:a@b.example', 'https://', '', 'https://[::1]', 'https://app.example:99999', 'https://app.example:8443', 'https://app.example:443', 'https://127.0.0.1:8443', 5, null, 'https://' + 'a'.repeat(300) + '.example'];
    for (const raw of bad) expect(() => parseBaseUrl(raw), String(raw)).toThrowError(expect.objectContaining({ code: 'verify_base_url_invalid' }));
  });
  it('a patch is checked as a whole and never leaves a repository on without an address', () => {
    expect(() => applySettingsPatch(current, { enabled: true })).toThrowError(expect.objectContaining({ code: 'verify_base_url_required' }));
    const on = applySettingsPatch(current, { enabled: true, baseUrl: 'https://app.example' });
    expect(on).toMatchObject({ enabled: true, baseUrl: 'https://app.example' });
    expect(() => applySettingsPatch(on, { baseUrl: null })).toThrowError(expect.objectContaining({ code: 'verify_base_url_required' }));
    expect(applySettingsPatch(on, { enabled: false, baseUrl: null }).baseUrl).toBeNull();
    expect(() => applySettingsPatch(current, { enabled: 'yes' as unknown as boolean })).toThrowError(expect.objectContaining({ code: 'verify_setting_invalid' }));
    expect(() => applySettingsPatch(current, { eligibility: 'sometimes' as 'all' })).toThrowError(expect.objectContaining({ code: 'verify_setting_invalid' }));
    for (const paths of ['apps', ['/etc'], ['a/../b'], ['a b'], Array.from({ length: 21 }, (_v, i) => `p${i}`), [5]]) expect(() => applySettingsPatch(current, { eligibilityPaths: paths }), JSON.stringify(paths)).toThrowError(expect.objectContaining({ code: 'verify_setting_invalid' }));
    expect(applySettingsPatch(current, { eligibilityPaths: ['apps/web', 'apps/web'] }).eligibilityPaths).toEqual(['apps/web']);
    for (const label of ['', '   ', 'x'.repeat(101), 'a\nb']) expect(() => applySettingsPatch(current, { testAccountLabel: label }), label).toThrowError(expect.objectContaining({ code: 'verify_setting_invalid' }));
    expect(applySettingsPatch(current, { testAccountLabel: '  tester  ' }).testAccountLabel).toBe('tester');
  });
});
