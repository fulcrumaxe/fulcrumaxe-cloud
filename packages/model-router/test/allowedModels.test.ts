import { describe, expect, it } from 'vitest';
// Relative on purpose: @fx/model-router must not depend on @fx/core (see role-model-parity.test.ts).
import { ROLE_MODEL_IDS } from '../../core/src/role-settings/types.js';
import { allowedModelsFor } from '../src/allowedModels.js';
import { applyCustomerOverride, ROLE_FLOORS } from '../src/floors.js';
import { ALL_ROUTABLE_ROLES } from '../src/roleUniverse.js';

// What the role-model PATCH accepts: an id the service knows AND the floor verdict.
const patchAccepts = (role: string, id: string): boolean =>
  (ROLE_MODEL_IDS as readonly string[]).includes(id) && applyCustomerOverride(role, id).accepted;

const UNIVERSE = [...ROLE_MODEL_IDS, 'not-a-model', 'openrouter/auto', 'sonnet-5:floor'];

describe('allowedModelsFor', () => {
  it('lists an id exactly when the PATCH path would accept it, for every role and id', () => {
    expect(ALL_ROUTABLE_ROLES.length).toBeGreaterThan(20);
    for (const role of ALL_ROUTABLE_ROLES) {
      for (const id of UNIVERSE) {
        const listed = allowedModelsFor(role, undefined, ROLE_MODEL_IDS).includes(id);
        expect(listed, `${role} ${id}`).toBe(patchAccepts(role, id));
      }
    }
  });

  it('floored roles get only the allowlisted claude-code models at or above the floor, whatever the account backend', () => {
    for (const backend of [undefined, { backend: 'openrouter', provider: 'openai' }]) {
      for (const role of Object.keys(ROLE_FLOORS)) {
        expect(allowedModelsFor(role, backend, ROLE_MODEL_IDS)).toEqual(['sonnet-5', 'opus-5']);
      }
    }
  });

  it('an unfloored role gets the whole universe, in order', () => {
    expect(allowedModelsFor('build', undefined, ROLE_MODEL_IDS)).toEqual([...ROLE_MODEL_IDS]);
  });

  it('an id added to the universe reaches unfloored roles and stays out of floored ones', () => {
    const wider = [...ROLE_MODEL_IDS, 'fixture-model-9'];
    expect(allowedModelsFor('build', undefined, wider)).toContain('fixture-model-9');
    expect(allowedModelsFor('security-reviewer', undefined, wider)).toEqual(['sonnet-5', 'opus-5']);
  });
});
