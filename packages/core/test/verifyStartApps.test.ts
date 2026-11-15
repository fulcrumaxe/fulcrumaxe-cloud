import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CRITERION_TAG_RULES } from '../src/verify/criteria.js';
import { deriveJourneys, planJourneys } from '../src/verify/journeys.js';
import { extractStart, isStartApp, VERIFY_START_APPS } from '../src/verify/startApps.js';

/** D#749: a journey can name the app it starts in, from a closed list; nothing else a criterion says reaches the tester as a start. */
describe('extractStart', () => {
  it('takes a marker out of the text and returns a listed app', () => {
    expect(extractStart('[ui] [start: runs] A verifier run shows its role')).toEqual({ text: '[ui] A verifier run shows its role', start: 'runs' });
    expect(extractStart('The mode shows [START: Needs-You] on the card')).toEqual({ text: 'The mode shows on the card', start: 'needs-you' });
  });
  it('drops a marker that names anything off the list, and keeps no start', () => {
    for (const bad of ['https://evil.example', '#/runs/abc', 'runs/../x', 'nope', '', '__proto__', 'constructor']) {
      expect(extractStart(`[start: ${bad}] See the page`).start, bad).toBeUndefined();
      expect(extractStart(`[start: ${bad}] See the page`).text).not.toContain('start');
    }
  });
  it('uses the first listed marker', () => {
    expect(extractStart('[start: nope] [start: roles] [start: runs] x').start).toBe('roles');
  });
  it('lists no id that is not an app of the workspace, and every app it ships can be named', () => {
    const dir = join(__dirname, '../../../apps/workspace/apps');
    if (!existsSync(dir)) return; // a public-tree extract may not hold the workspace
    const apps = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'manifest.json'))).map((d) => d.name).sort();
    expect(Object.keys(VERIFY_START_APPS).sort()).toEqual(apps);
    for (const id of apps) {
      const title = /FULC\.register\(\{\s*id:\s*"[^"]+",\s*title:\s*"([^"]+)"/.exec(readdirSync(join(dir, id)).filter((f) => /-app\.js$|^main\.[jt]sx?$/.test(f)).map((f) => readFileSync(join(dir, id, f), 'utf8')).join('\n'));
      expect(title?.[1], id).toBe(VERIFY_START_APPS[id]);
    }
  });
  it('isStartApp is false for inherited names and non-strings', () => {
    expect(isStartApp('toString')).toBe(false);
    expect(isStartApp(42)).toBe(false);
    expect(isStartApp('runs')).toBe(true);
  });
});

describe('journeys carry a start', () => {
  it('a criterion with a marker becomes a journey with that start and a clean text; classification still sees the tag', () => {
    const body = '1. [ui] [start: pipeline] A verifier run line names its role\n2. [start: roles] [code] `x` returns 1\n3. [ui] Plain criterion';
    const plan = planJourneys({ specBody: body, standing: [] });
    expect(plan.journeys).toEqual([
      { id: 'c1', source: 'criterion', text: 'A verifier run line names its role', start: 'pipeline' },
      { id: 'c3', source: 'criterion', text: 'Plain criterion' },
    ]);
    expect(plan.checksOnly).toEqual([2]);
  });
  it('an unlisted marker leaves a journey without a start', () => {
    expect(deriveJourneys({ specBody: '1. [ui] [start: https://evil.example] Open it', standing: [] })).toEqual([{ id: 'c1', source: 'criterion', text: 'Open it' }]);
  });
  it('a carried journey keeps its start; the current Spec wins; an unlisted carried start is dropped', () => {
    const body = '1. [ui] [start: runs] A';
    const j = deriveJourneys({ specBody: body, standing: [], carried: [{ id: 'c1', text: 'A again', start: 'roles' }, { id: 'c9', text: 'Old', start: 'roles' }, { id: 'c8', text: 'Bad', start: 'http://x' }] });
    expect(j).toEqual([
      { id: 'c1', source: 'recheck', text: 'A again', start: 'runs' },
      { id: 'c9', source: 'recheck', text: 'Old', start: 'roles' },
      { id: 'c8', source: 'recheck', text: 'Bad' },
    ]);
  });
  it('on a recheck, a current Spec that no longer has a start marker drops the carried start', () => {
    const j = deriveJourneys({ specBody: '1. [ui] A without a marker\n2. [ui] [start: runs] B', standing: [], carried: [{ id: 'c1', text: 'A again', start: 'roles' }, { id: 'c2', text: 'B again', start: 'roles' }] });
    expect(j).toEqual([
      { id: 'c1', source: 'recheck', text: 'A again' },
      { id: 'c2', source: 'recheck', text: 'B again', start: 'runs' },
    ]);
  });
  it('the Spec writers are told about the marker with the real app ids', () => {
    expect(CRITERION_TAG_RULES).toContain('[start: <app id>]');
    for (const id of Object.keys(VERIFY_START_APPS)) expect(CRITERION_TAG_RULES).toContain(id);
  });
});
