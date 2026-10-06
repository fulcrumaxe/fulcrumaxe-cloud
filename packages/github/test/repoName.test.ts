import { describe, expect, it } from 'vitest';
import { validateNewRepo } from '../src/repoName.js';

describe('validateNewRepo (D#2 RC-1a)', () => {
  it.each<[string, Record<string, unknown>, boolean]>([
    ['a plain name', { name: 'my-repo_1.x' }, true],
    ['100 characters', { name: 'a'.repeat(100) }, true],
    ['101 characters', { name: 'a'.repeat(101) }, false],
    ['empty', { name: '' }, false],
    ['..', { name: '..' }, false],
    ['.', { name: '.' }, false],
    ['ends in .git', { name: 'x.git' }, false],
    ['ends in .GIT', { name: 'X.GIT' }, false],
    ['a space', { name: 'a b' }, false],
    ['a slash', { name: 'a/b' }, false],
    ['unicode', { name: 'répo' }, false],
    ['not a string', { name: 5 }, false],
    ['an empty description', { name: 'a', description: '' }, true],
    ['a 350-char description', { name: 'a', description: 'd'.repeat(350) }, true],
    ['a 351-char description', { name: 'a', description: 'd'.repeat(351) }, false],
    ['a control character in the description', { name: 'a', description: 'x\u0007y' }, false],
    ['a newline in the description', { name: 'a', description: 'x\ny' }, false],
    ['internal visibility', { name: 'a', visibility: 'internal' }, false],
    ['public visibility', { name: 'a', visibility: 'public' }, true],
    ['a non-boolean auto_init', { name: 'a', autoInit: 'yes' }, false],
  ])('%s', (_n, input, ok) => {
    expect(validateNewRepo({ ...input, name: input.name }).ok).toBe(ok);
  });

  it('defaults to private with a README, and trims the description', () => {
    expect(validateNewRepo({ name: 'a', description: '  hi  ' })).toEqual({
      ok: true,
      value: { name: 'a', visibility: 'private', description: 'hi', autoInit: true },
    });
  });
});
