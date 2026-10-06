import { describe, expect, it } from 'vitest';
import { isSigninAllowed, signinAllowlist } from '../../src/auth/signinAllowlist.js';

describe('FX_SIGNIN_ALLOWLIST parsing', () => {
  it('unset, empty and blank-only values restrict nothing', () => {
    for (const value of [undefined, '', '   ', ' , ,, ']) {
      const env = value === undefined ? {} : { FX_SIGNIN_ALLOWLIST: value };
      expect(signinAllowlist(env)).toBeNull();
      expect(isSigninAllowed('anyone', env)).toBe(true);
      expect(isSigninAllowed(null, env)).toBe(true);
    }
  });

  it('allows a listed login in any case and ignores blank entries', () => {
    const env = { FX_SIGNIN_ALLOWLIST: ' Octo-Cat ,, other ' };
    expect(isSigninAllowed('octo-cat', env)).toBe(true);
    expect(isSigninAllowed('OCTO-CAT', env)).toBe(true);
    expect(isSigninAllowed(' other', env)).toBe(true);
  });

  it('refuses an unlisted or missing login once the list is set', () => {
    const env = { FX_SIGNIN_ALLOWLIST: 'octo-cat' };
    expect(isSigninAllowed('octo-cat2', env)).toBe(false);
    expect(isSigninAllowed('', env)).toBe(false);
    expect(isSigninAllowed(null, env)).toBe(false);
  });
});
