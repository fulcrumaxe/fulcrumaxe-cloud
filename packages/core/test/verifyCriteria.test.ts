import { describe, expect, it } from 'vitest';
import { classifyCriterion, classifyCriteria, CRITERION_TAG_RULES } from '../src/verify/criteria.js';
import { planJourneys } from '../src/verify/journeys.js';
import { nextStreak, streakOf, type StreakInput } from '../src/verify/rows.js';

const kind = (s: string) => classifyCriterion(s).kind;

describe('classifyCriterion: the criteria of issue 766', () => {
  it('code-level criteria are code', () => {
    expect(kind('`repoLabel({full_name: "acme/widgets"})` is `"acme/widgets"`')).toBe('code');
    expect(kind('`repoLabel({full_name: null, name: "w"})` is `"w"`')).toBe('code');
    expect(kind('`pickRepoId` returns the only repository id when the list has one entry')).toBe('code');
    expect(kind('`pickRepoId([])` returns `null`')).toBe('code');
    expect(kind('The helper `pickRepoId` throws for a list that is not an array')).toBe('code');
  });
  it('user-visible criteria are visible', () => {
    expect(kind('The Autonomy picker\'s option texts are exactly ["Ask me", "Auto"]')).toBe('visible');
    expect(kind('The Apply-to select lists every connected repository by name')).toBe('visible');
    expect(kind('A person opens Settings and sees the repository name instead of its id')).toBe('visible');
  });
  it('other code subjects: files, SQL, status codes, tests', () => {
    expect(kind('Migration 1010 adds the column and keeps existing rows')).toBe('code');
    expect(kind('GET /api/v1/x answers status 404 for another account')).toBe('code');
    expect(kind('packages/core/src/verify/rows.ts exports nextStreak')).toBe('code');
    expect(kind('A unit test covers the empty list')).toBe('code');
  });
  it('a code lead that names a surface is visible (the cost of a wrong guess is not symmetric)', () => {
    expect(kind("`pickRepoId` returns the id of the picker's selected option")).toBe('visible');
  });
  it('unsure is visible', () => {
    expect(kind('Everything keeps working')).toBe('visible');
    expect(classifyCriterion('Everything keeps working').by).toBe('default');
  });
});

describe('classifyCriterion: tags override the rule', () => {
  it('[ui] and [code] win, and are removed from the text', () => {
    expect(classifyCriterion('[code] The retry helper has a function')).toMatchObject({ kind: 'code', by: 'tag', text: 'The retry helper has a function' });
    expect(classifyCriterion('[ui] `repoLabel` is exported')).toMatchObject({ kind: 'visible', by: 'tag', text: '`repoLabel` is exported' });
    expect(classifyCriterion('**[UI]** The page shows a toast')).toMatchObject({ kind: 'visible', text: 'The page shows a toast' });
    expect(classifyCriterion('[Code]: only the build is involved')).toMatchObject({ kind: 'code', text: 'only the build is involved' });
  });
  it('[code] never hides a criterion the rule finds visible; [ui] still overrides everything', () => {
    for (const t of ['[code] A person opens Settings and sees the repository name instead of its id', '[code] The Settings page lists every repository by name']) expect(kind(t), t).toBe('visible');
    expect(kind('[code] `f` returns 1')).toBe('code');
    expect(kind('[code] Everything keeps working')).toBe('code');
    expect(kind('[ui] migration 1010 adds a column')).toBe('visible');
  });
  it('display verbs are visible signals, tested before the code subjects', () => {
    for (const t of ['After the migration, existing repositories still appear in Settings with their names', 'The Inbox shows the new item; the endpoint returns 201', 'The Settings API returns the repo names, which appear in the Apply-to list']) expect(kind(t), t).toBe('visible');
  });
  it('an unknown tag is not a tag', () => {
    expect(classifyCriterion('[todo] fix the button').by).not.toBe('tag');
  });
  it('the Spec writer prompt text names both tags', () => {
    expect(CRITERION_TAG_RULES).toContain('[ui]');
    expect(CRITERION_TAG_RULES).toContain('[code]');
  });
});

describe('planJourneys', () => {
  const spec = ['## Spec', '1. [code] `repoLabel({full_name: "a/b"})` is `"a/b"`', '2. The picker option texts are exactly [A, B]', '3. `pickRepoId([])` returns `null`', '4. A person opens the page and sees a button'].join('\n');
  it('only visible criteria become journeys, keeping the Spec numbers', () => {
    const plan = planJourneys({ specBody: spec, standing: [] });
    expect(plan.journeys.map((j) => j.id)).toEqual(['c2', 'c4']);
    expect(plan.checksOnly).toEqual([1, 3]);
  });
  it('standing journeys are kept; a recheck of a left-out id is added after', () => {
    const plan = planJourneys({ specBody: spec, standing: [{ id: 'login', text: 'Sign in' }], carried: [{ id: 'c1', text: 'again' }] });
    expect(plan.journeys.map((j) => j.id)).toEqual(['c2', 'c4', 's_login', 'c1']);
  });
  it('a Spec with only code criteria and no standing journey has none', () => {
    const plan = planJourneys({ specBody: '1. `f` returns 1\n2. [code] a column exists', standing: [] });
    expect(plan.journeys).toEqual([]);
    expect(plan.checksOnly).toEqual([1, 2]);
  });
  it('classifyCriteria numbers from 1', () => {
    expect(classifyCriteria(['a', 'b']).map((c) => c.n)).toEqual([1, 2]);
  });
});

describe('streak: unverified no_visible_journeys is neutral', () => {
  const clean: StreakInput = { status: 'verified', method: 'chrome_runner', mergedByProduct: true, deployByOrder: true, personStep: false, criterionPassed: true };
  const neutral: StreakInput = { ...clean, status: 'unverified', method: null, reason: 'no_visible_journeys' };
  it('neither counts nor resets', () => {
    expect(nextStreak(2, neutral)).toBe(2);
    expect(nextStreak(0, neutral)).toBe(0);
    expect(streakOf([clean, clean, neutral, clean])).toBe(3);
  });
  it('a verified row that passed on standing journeys alone is neutral; one with a criterion journey passed counts', () => {
    expect(nextStreak(2, { ...clean, criterionPassed: false })).toBe(2);
    expect(nextStreak(2, clean)).toBe(3);
    expect(nextStreak(2, { ...clean, criterionPassed: false, deployByOrder: false })).toBe(0);
    expect(nextStreak(2, { ...clean, criterionPassed: false, status: 'failed' })).toBe(0);
  });
  it('every other unverified reason still resets', () => {
    expect(nextStreak(2, { ...neutral, reason: 'journey_blocked' })).toBe(0);
    expect(nextStreak(2, { ...neutral, reason: null })).toBe(0);
  });
  it('a merge the product did not make is skipped, and a person step on it still resets', () => {
    expect(nextStreak(2, { ...neutral, mergedByProduct: false })).toBe(2);
    expect(nextStreak(2, { ...neutral, personStep: true })).toBe(0);
  });
});
