import { describe, expect, it } from 'vitest';
import { genuineSyncCommit, parseSyncMessage, qualifyDeployedCommit, type QualifyInput } from '../src/verify/qualify.js';

const MERGE = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const sync = (hex: string): string => `Sync private main with code-plane/main (${hex})`;
const base: QualifyInput = { deployed: OTHER, mergeSha: MERGE, twoPlane: true, deployedMessage: sync(MERGE.slice(0, 12)), namedCommit: MERGE };
/** A different commit that shares the merge commit's first 12 hex (a 48-bit prefix collision). */
const COLLIDING = MERGE.slice(0, 12) + 'e'.repeat(28);

describe('parseSyncMessage', () => {
  it('reads only the exact first-line form', () => {
    expect(parseSyncMessage(sync('0123456789ab'))).toBe('0123456789ab');
    expect(parseSyncMessage(`${sync('0123456789ab')}\n\nbody text`)).toBe('0123456789ab');
    expect(parseSyncMessage(`${sync('0123456789ab')}\r\nbody`)).toBe('0123456789ab');
  });
  it('refuses garbage', () => {
    const bad: unknown[] = [
      null, undefined, 42, '', 'Sync private main with code-plane/main (short)', sync('0123456789AB'), sync('0123456789abc'), sync('0123456789a'),
      ` ${sync('0123456789ab')}`, `${sync('0123456789ab')} extra`, `prefix\n${sync('0123456789ab')}`, 'Merge pull request #5', 'Sync private main with code-plane/main (0123456789ab',
      'sync private main with code-plane/main (0123456789ab)',
    ];
    for (const m of bad) expect(parseSyncMessage(m), String(m)).toBeNull();
  });
});

describe('qualifyDeployedCommit', () => {
  it('the merge commit itself qualifies, with or without a second plane, in any case', () => {
    expect(qualifyDeployedCommit({ deployed: MERGE, mergeSha: MERGE, twoPlane: false })).toEqual({ qualifies: true, via: 'same_commit' });
    expect(qualifyDeployedCommit({ deployed: MERGE.toUpperCase(), mergeSha: MERGE, twoPlane: true })).toEqual({ qualifies: true, via: 'same_commit' });
  });
  it('a sync commit whose second parent IS the merge commit (equal in full) qualifies without a compare', () => {
    expect(qualifyDeployedCommit(base)).toEqual({ qualifies: true, via: 'sync_identical' });
    expect(qualifyDeployedCommit({ ...base, namedRelation: 'unknown' })).toEqual({ qualifies: true, via: 'sync_identical' });
    expect(qualifyDeployedCommit({ ...base, namedCommit: MERGE.toUpperCase() })).toEqual({ qualifies: true, via: 'sync_identical' });
  });
  it('a 12-hex prefix alone never makes a commit the merge commit: a colliding second parent, or none given, needs the relation', () => {
    const no = { qualifies: false, reason: 'commit_not_deployed' };
    expect(qualifyDeployedCommit({ ...base, namedCommit: COLLIDING })).toEqual(no);
    expect(qualifyDeployedCommit({ ...base, namedCommit: COLLIDING, namedRelation: 'unknown' })).toEqual(no);
    expect(qualifyDeployedCommit({ ...base, namedCommit: COLLIDING, namedRelation: 'identical' })).toEqual(no);
    expect(qualifyDeployedCommit({ ...base, namedCommit: COLLIDING, namedRelation: 'diverged' })).toEqual(no);
    const withoutNamed: QualifyInput = { ...base };
    delete withoutNamed.namedCommit;
    expect(qualifyDeployedCommit(withoutNamed)).toEqual(no);
    // The host's own relation can still qualify it: a colliding commit that really is a descendant.
    expect(qualifyDeployedCommit({ ...base, namedCommit: COLLIDING, namedRelation: 'ahead' })).toEqual({ qualifies: true, via: 'sync_descends' });
    // A named commit that does not even start with the message's prefix is not the commit the message names.
    expect(qualifyDeployedCommit({ ...base, namedCommit: OTHER })).toEqual(no);
  });
  it('a sync commit naming a descendant of the merge commit qualifies', () => {
    expect(qualifyDeployedCommit({ ...base, deployedMessage: sync('c'.repeat(12)), namedCommit: 'c'.repeat(40), namedRelation: 'ahead' })).toEqual({ qualifies: true, via: 'sync_descends' });
  });
  it('a relation of "identical" does not qualify a commit whose named prefix is not the merge commit\'s', () => {
    expect(qualifyDeployedCommit({ ...base, deployedMessage: sync('c'.repeat(12)), namedRelation: 'identical' })).toEqual({ qualifies: false, reason: 'commit_not_deployed' });
  });
  it('an older commit, a sibling and an unread relation do not qualify', () => {
    const named = { ...base, deployedMessage: sync('c'.repeat(12)) };
    for (const namedRelation of ['behind', 'diverged', 'unknown', undefined] as const) expect(qualifyDeployedCommit({ ...named, namedRelation }), String(namedRelation)).toEqual({ qualifies: false, reason: 'commit_not_deployed' });
  });
  it('a different commit with a message that does not parse, or in a repository with one plane, does not qualify', () => {
    const no = { qualifies: false, reason: 'commit_not_deployed' };
    expect(qualifyDeployedCommit({ ...base, deployedMessage: 'Merge pull request #5' })).toEqual(no);
    expect(qualifyDeployedCommit({ ...base, deployedMessage: null })).toEqual(no);
    expect(qualifyDeployedCommit({ ...base, deployedMessage: undefined })).toEqual(no);
    expect(qualifyDeployedCommit({ ...base, twoPlane: false })).toEqual(no);
    expect(qualifyDeployedCommit({ ...base, twoPlane: false, deployedMessage: sync('c'.repeat(12)), namedRelation: 'ahead' })).toEqual(no);
  });
  it('refuses a value that is not a commit id, whatever else is true', () => {
    const no = { qualifies: false, reason: 'commit_not_deployed' };
    expect(qualifyDeployedCommit({ ...base, deployed: 'abc123' })).toEqual(no);
    expect(qualifyDeployedCommit({ ...base, mergeSha: 'abc123' })).toEqual(no);
    expect(qualifyDeployedCommit({ ...base, deployed: '' })).toEqual(no);
    expect(qualifyDeployedCommit({ deployed: 'z'.repeat(40), mergeSha: 'z'.repeat(40), twoPlane: false })).toEqual(no);
  });
});

describe('genuineSyncCommit (D#749 V3a: the check that comes before the sync rule)', () => {
  const FIRST = 'f'.repeat(40);
  const NAMED = '0123456789ab' + 'c'.repeat(28);
  const msg = sync('0123456789ab');
  it('a merge commit whose second parent starts with the 12 hex the message names is genuine, and the parent is the id returned (never text from the message)', () => {
    expect(genuineSyncCommit({ parents: [FIRST, NAMED], message: msg })).toEqual({ named: NAMED });
    expect(genuineSyncCommit({ parents: [FIRST.toUpperCase(), NAMED.toUpperCase()], message: `${msg}\n\nbody` })).toEqual({ named: NAMED });
    expect(genuineSyncCommit({ parents: ['1'.repeat(64), '0123456789ab' + 'd'.repeat(52)], message: msg })).toEqual({ named: '0123456789ab' + 'd'.repeat(52) });
  });
  it('a crafted message on anything else is not: one parent, three parents, no parents, the wrong second parent, equal parents, a bad id, a bad message, no commit', () => {
    const no: Array<Parameters<typeof genuineSyncCommit>[0]> = [
      { parents: [NAMED], message: msg },
      { parents: [FIRST, NAMED, FIRST], message: msg },
      { parents: [], message: msg },
      { parents: [FIRST, 'a'.repeat(40)], message: msg },
      { parents: [NAMED, NAMED], message: msg },
      { parents: [FIRST, '0123456789ab'], message: msg },
      { parents: ['zz', NAMED], message: msg },
      { parents: [FIRST, NAMED], message: 'Merge pull request #5' },
      { parents: [FIRST, NAMED], message: sync('0123456789AB') },
      { parents: [FIRST, 42 as unknown as string], message: msg },
      { parents: 'ab' as unknown as string[], message: msg },
      null,
    ];
    for (const c of no) expect(genuineSyncCommit(c), JSON.stringify(c)).toBeNull();
  });
  it('the first parent may be anything that is a commit id: it is the private plane\'s own history, which the cloud cannot see; the proof is the second parent', () => {
    expect(genuineSyncCommit({ parents: ['9'.repeat(40), NAMED], message: msg })).not.toBeNull();
  });
});
