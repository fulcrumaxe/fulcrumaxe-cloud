import { describe, expect, it } from 'vitest';
import { isSignInBaseUrl, readSignInNeeds, signInCommand } from '../src/verify/signInNeeds.js';

/** A fake client: the runners read answers with the given states, the repository read with the given rows. */
function fakeClient(states: string[], baseUrls: string[]) {
  return {
    query: async (sql: string) => {
      if (sql.includes('FROM runners')) return { rows: states.map((s) => ({ s })) };
      return { rows: baseUrls.map((base_url, i) => ({ repo_id: `r${i}`, gh_owner: 'o', gh_name: `n${i}`, base_url, parked_since: null })) };
    },
  } as never;
}

describe('D#749 sign-in need: the address is checked again on the server', () => {
  const GOOD = 'https://app.example.test:8443';
  const BAD = ['https://a.example.test;id', 'https://a.example.test/;id', 'https://a.example.test|id', 'https://a.example.test\nid', 'https://a.example.test/', 'https://A.example.test', "https://a.example.test'x", 'http://localhost:3000', 'https://exämple.test', 'https://a.example.test:99999999', 'fx; id', '', 'https://a.example.test$(id)'];

  it('accepts exactly the shape of the settings constraint', () => {
    expect(isSignInBaseUrl(GOOD)).toBe(true);
    expect(isSignInBaseUrl('https://app.example.test')).toBe(true);
    for (const v of BAD) expect(isSignInBaseUrl(v), v).toBe(false);
    expect(isSignInBaseUrl(null)).toBe(false);
    expect(isSignInBaseUrl(5)).toBe(false);
  });

  it('drops an entry whose stored address got past the database check, and keeps the good one beside it', async () => {
    const out = await readSignInNeeds(fakeClient(['expired'], [...BAD, GOOD]), 'acct');
    expect(out.map((n) => n.baseUrl)).toEqual([GOOD]);
    expect(signInCommand(out[0]!.baseUrl)).toBe(`fx-runner verify-login --base-url ${GOOD}`);
  });
});
