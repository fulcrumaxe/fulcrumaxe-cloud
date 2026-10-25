import { describe, expect, it } from 'vitest';
import { validatePairingInput, type SetRepoPairingInput } from '../../src/repos/pairing.js';
import { InvalidRoleSettingsInputError } from '../../src/role-settings/errors.js';

/** A pairing's rule files decide what may be published, so each must sit under one of the pairing's private paths. */
const BASE: SetRepoPairingInput = { codeRepo: 'acme/widgets-public', overlayGlobs: ['docs/ops/', 'rules/'] };

function refusal(input: SetRepoPairingInput): InvalidRoleSettingsInputError {
  try {
    validatePairingInput(input);
  } catch (e) {
    expect(e).toBeInstanceOf(InvalidRoleSettingsInputError);
    return e as InvalidRoleSettingsInputError;
  }
  throw new Error('expected a refusal');
}

describe('pairing validation: rule files must be private paths', () => {
  it('accepts rule files that a private path covers: a folder, an exact path or a glob, matched as the push scan matches them', () => {
    for (const overlayGlobs of [['rules/'], ['rules/ids.txt', 'rules/plan.json'], ['rules/*'], ['**/*.txt', '**/*.json'], ['Rules/']]) {
      expect(() => validatePairingInput({ ...BASE, overlayGlobs, identifierRulesPath: 'rules/ids.txt', planDataRulesPath: 'rules/plan.json' }), overlayGlobs.join(',')).not.toThrow();
    }
    expect(() => validatePairingInput({ ...BASE, identifierRulesPath: null, planDataRulesPath: null })).not.toThrow();
    expect(() => validatePairingInput({ ...BASE, overlayGlobs: ['docs/'] })).not.toThrow();
  });

  it('refuses an identifier-rules file outside every private path, naming the field', () => {
    const e = refusal({ ...BASE, overlayGlobs: ['docs/ops/'], identifierRulesPath: 'rules/ids.txt' });
    expect(e.message).toMatch(/^rule files must be private paths/);
    expect(e.field).toBe('identifier_rules_path');
  });

  it('refuses a plan-data file outside every private path, also when the other rule file is covered', () => {
    const e = refusal({ ...BASE, overlayGlobs: ['rules/ids.txt'], identifierRulesPath: 'rules/ids.txt', planDataRulesPath: 'rules/plan.json' });
    expect(e.field).toBe('plan_data_rules_path');
  });

  it('a path beside a private folder, or one that only starts with its name, is not covered', () => {
    expect(refusal({ ...BASE, overlayGlobs: ['rules/private/'], identifierRulesPath: 'rules/ids.txt' }).field).toBe('identifier_rules_path');
    expect(refusal({ ...BASE, overlayGlobs: ['rules'], identifierRulesPath: 'rules-public/ids.txt' }).field).toBe('identifier_rules_path');
  });
});
