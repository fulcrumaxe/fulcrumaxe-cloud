import { describe, expect, it } from 'vitest';
import { ContextRuleError, assertContextRulePath, mapRuleDbError, resolveContextRules, type ContextRule } from '../src/context/contextRules.js';

const rule = (scope: 'repo' | 'item', kind: 'pin' | 'exclude', path: string): ContextRule => ({
  id: `${scope}-${path}`,
  scope,
  kind,
  path,
  repoId: scope === 'repo' ? 'r' : null,
  workItemId: scope === 'item' ? 'w' : null,
});

/** D#600 CX-5a: the application's copy of the definer's path check, and how an item's rules sit over the repository's. */
describe('assertContextRulePath', () => {
  const refused = (kind: 'pin' | 'exclude', path: unknown) => {
    try {
      assertContextRulePath(kind, path);
    } catch (e) {
      expect(e).toBeInstanceOf(ContextRuleError);
      expect((e as ContextRuleError).code).toBe('invalid_path');
      return true;
    }
    return false;
  };

  it('refuses .., absolute, empty, control, backslash and odd segments for both kinds', () => {
    const bad = ['', '..', '../x', 'a/../b', '/x', '/', '~', '~/x', 'C:/x', 'a\\b', 'a\nb', 'a\u0001b', 'a\u007fb', 'a\u0085b', 'a\u2028b', 'a//b', 'a/', './a', 'a/./b', 'x'.repeat(513), null, undefined, 5];
    for (const kind of ['pin', 'exclude'] as const) for (const p of bad) expect(refused(kind, p), `${kind} ${JSON.stringify(p)}`).toBe(true);
  });

  it('accepts names that only look like the refused ones, at exactly 512 characters', () => {
    for (const kind of ['pin', 'exclude'] as const) for (const p of ['a..b', '.env', 'dir/.hidden', 'a b/c.txt', '你好/x.md', 'x'.repeat(512), '~user/x', 'c:x']) expect(refused(kind, p), p).toBe(false);
  });

  it('* and ? are refused in a pin and accepted in an exclude; [ ] { } are literal in a pin', () => {
    for (const p of ['src/*.ts', 'a?b', '**/x']) {
      expect(refused('pin', p), p).toBe(true);
      expect(refused('exclude', p), p).toBe(false);
    }
    for (const p of ['app/[id]/page.tsx', 'app/{a,b}', 'src/[ab].ts']) {
      expect(refused('pin', p), p).toBe(false);
      expect(refused('exclude', p), p).toBe(false);
    }
    expect(refused('exclude', 'src/**/[ab].ts')).toBe(false);
  });
});

describe('resolveContextRules', () => {
  it('an item rule overrides the repo rule for the same path, whatever the kinds; the rest of the repo rules stay; sorted by path', () => {
    const repo = [rule('repo', 'pin', 'b.md'), rule('repo', 'exclude', 'a/**'), rule('repo', 'pin', 'c.md')];
    const item = [rule('item', 'exclude', 'b.md'), rule('item', 'pin', 'c.md')];
    expect(resolveContextRules(repo, item).map((r) => `${r.scope}:${r.kind}:${r.path}`)).toEqual(['repo:exclude:a/**', 'item:exclude:b.md', 'item:pin:c.md']);
  });

  it('with no item rules the repo rules stand, and with neither the list is empty', () => {
    const repo = [rule('repo', 'exclude', 'z'), rule('repo', 'pin', 'a')];
    expect(resolveContextRules(repo, []).map((r) => r.path)).toEqual(['a', 'z']);
    expect(resolveContextRules([], [])).toEqual([]);
  });
});

describe('mapRuleDbError', () => {
  it('turns the definer invalid_path into a ContextRuleError and passes everything else through untouched', () => {
    const mapped = mapRuleDbError({ code: '22023', message: 'invalid_path' });
    expect(mapped).toBeInstanceOf(ContextRuleError);
    for (const other of [{ code: '22023', message: 'invalid_message' }, { code: '42501', message: 'invalid_path' }, new Error('boom'), null, 'x']) expect(mapRuleDbError(other)).toBe(other);
  });
});
