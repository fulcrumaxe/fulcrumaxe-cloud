import { describe, expect, it } from 'vitest';
import { DEFAULT_VERIFY_SETTINGS, applySettingsPatch, diffVerifySettings, type VerifySettings } from '../src/verify/settings.js';

const base: VerifySettings = { repoId: 'r', ...DEFAULT_VERIFY_SETTINGS };

/** D#749 V4a: the audit payload of a settings save is the diff between the settings before and after, and nothing else. */
describe('diffVerifySettings', () => {
  it('names nothing when nothing changed', () => {
    expect(diffVerifySettings(base, applySettingsPatch(base, {}))).toEqual({});
    const on = applySettingsPatch(base, { enabled: true, baseUrl: 'https://app.example.test' });
    expect(diffVerifySettings(on, applySettingsPatch(on, { enabled: true, baseUrl: 'https://app.example.test/' }))).toEqual({});
  });

  it('names each changed field once, by the API field name, with its old and new value', () => {
    const next = applySettingsPatch(base, { enabled: true, baseUrl: 'https://app.example.test', browserDriver: 'chrome', testAccountLabel: ' bot ', eligibility: 'all', eligibilityPaths: ['apps/web'] });
    expect(diffVerifySettings(base, next)).toEqual({
      enabled: { from: false, to: true },
      base_url: { from: null, to: 'https://app.example.test' },
      browser_driver: { from: 'playwright', to: 'chrome' },
      test_account_label: { from: null, to: 'bot' },
      eligibility: { from: 'ui_paths', to: 'all' },
      eligibility_paths: { from: [], to: ['apps/web'] },
    });
  });

  it('counts standing journeys and never copies their text', () => {
    const next = applySettingsPatch(base, { standingJourneys: [{ id: 'a', text: 'secret-looking text' }] });
    const diff = diffVerifySettings(base, next);
    expect(diff).toEqual({ standing_journeys: { from: 0, to: 1 } });
    expect(JSON.stringify(diff)).not.toContain('secret-looking');
    // An edit that keeps the count still counts as a change.
    expect(diffVerifySettings(next, applySettingsPatch(next, { standingJourneys: [{ id: 'a', text: 'other text' }] }))).toEqual({ standing_journeys: { from: 1, to: 1 } });
  });
});
