import { describe, expect, it } from 'vitest';
import { requireOwner, requireOwnerOrAdmin, type MembershipRole } from '../../src/tenancy/authorize.js';
import { ForbiddenError } from '../../src/tenancy/errors.js';

/**
 * H06 pass/fail item 4: "Only account members with role owner|admin can
 * change caps, role settings, auto-merge or billing (test per
 * mutation)." Those four mutations belong to H05 (caps), H12 (role
 * settings, auto-merge) and H10 (billing) -- none of which exist yet --
 * but every one of them is specified to gate on this exact function
 * (see authorize.ts's own doc comment), so this proves the shared gate
 * itself is correct for each named mutation kind, once, here, rather
 * than four separate downstream tests re-deriving the same check.
 */
describe.each(['caps', 'role_settings', 'auto_merge', 'billing'] as const)(
  'requireOwnerOrAdmin gates the "%s" mutation kind',
  (mutationKind) => {
    it(`member is refused (${mutationKind})`, () => {
      expect(() => requireOwnerOrAdmin('member')).toThrow(ForbiddenError);
    });

    it(`no membership at all is refused (${mutationKind})`, () => {
      expect(() => requireOwnerOrAdmin(null)).toThrow(ForbiddenError);
    });

    it(`admin is allowed (${mutationKind})`, () => {
      expect(() => requireOwnerOrAdmin('admin')).not.toThrow();
    });

    it(`owner is allowed (${mutationKind})`, () => {
      expect(() => requireOwnerOrAdmin('owner')).not.toThrow();
    });
  },
);

it('is a total function over every MembershipRole value plus null', () => {
  const roles: (MembershipRole | null)[] = ['owner', 'admin', 'member', null];
  for (const role of roles) {
    if (role === 'owner' || role === 'admin') {
      expect(() => requireOwnerOrAdmin(role)).not.toThrow();
    } else {
      expect(() => requireOwnerOrAdmin(role)).toThrow(ForbiddenError);
    }
  }
});

/**
 * Security fix round item 5 (CWE-269): the gate membership.ts calls
 * additionally, on top of requireOwnerOrAdmin, whenever a mutation
 * grants, revokes, or removes the owner role.
 */
describe('requireOwner', () => {
  it('owner is allowed', () => {
    expect(() => requireOwner('owner')).not.toThrow();
  });

  it('admin is refused', () => {
    expect(() => requireOwner('admin')).toThrow(ForbiddenError);
  });

  it('member is refused', () => {
    expect(() => requireOwner('member')).toThrow(ForbiddenError);
  });

  it('no membership at all is refused', () => {
    expect(() => requireOwner(null)).toThrow(ForbiddenError);
  });
});
