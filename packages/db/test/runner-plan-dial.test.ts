import { describe, expect, it } from 'vitest';
import { dispositionForPreset, isPresetName, resolveStoredDial, RUNNER_RUN_CATALOGUE_VERSION, RUNNER_RUN_DECISION_TYPE } from '../src/runnerPlanDial.js';
import { CATALOGUE_VERSION } from '@fx/decisions';

/** D#6 R2b-4a (C31 section 2.1 and 3, item 7): what the runner-run dial means, as data. */
describe('the runner-run dial', () => {
  it('names the catalogue entry and its version', () => {
    expect(RUNNER_RUN_DECISION_TYPE).toBe('runner_run_on_member_plan');
    expect(RUNNER_RUN_CATALOGUE_VERSION).toBe(CATALOGUE_VERSION);
  });

  it('with no row, the default is announce from the catalogue', () => {
    expect(resolveStoredDial(null)).toEqual({ disposition: 'announce', source: 'default', preset: null, version: null });
  });

  it('a stored row is an override, or a preset when it names one, and carries its version', () => {
    expect(resolveStoredDial({ disposition: 'ask', preset: null, version: 3 })).toEqual({ disposition: 'ask', source: 'override', preset: null, version: 3 });
    expect(resolveStoredDial({ disposition: 'act', preset: 'autonomous', version: 1 })).toEqual({ disposition: 'act', source: 'preset', preset: 'autonomous', version: 1 });
  });

  it('a stored disposition the entry does not allow fails closed to ask', () => {
    expect(resolveStoredDial({ disposition: 'maybe', preset: null, version: 2 }).disposition).toBe('ask');
  });

  it('the three presets resolve to ask, announce and act', () => {
    expect(dispositionForPreset('cautious')).toBe('ask');
    expect(dispositionForPreset('balanced')).toBe('announce');
    expect(dispositionForPreset('autonomous')).toBe('act');
  });

  it('knows exactly the three preset names', () => {
    for (const name of ['cautious', 'balanced', 'autonomous']) expect(isPresetName(name)).toBe(true);
    for (const name of ['', 'Balanced', 'moderate', null, 3, undefined]) expect(isPresetName(name)).toBe(false);
  });
});
