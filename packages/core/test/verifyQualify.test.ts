import { describe, expect, it } from 'vitest';
import { parseSyncMessage, qualifyDeployedCommit, type QualifyInput } from '../src/verify/qualify.js';

const MERGE = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const sync = (hex: string): string => `Sync private main with code-plane/main (${hex})`;
const base: QualifyInput = { deployed: OTHER, mergeSha: MERGE, twoPlane: true, deployedMessage: sync(MERGE.slice(0, 12)) };

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
  it('a sync commit naming the merge commit qualifies without a compare', () => {
    expect(qualifyDeployedCommit(base)).toEqual({ qualifies: true, via: 'sync_identical' });
    expect(qualifyDeployedCommit({ ...base, namedRelation: 'unknown' })).toEqual({ qualifies: true, via: 'sync_identical' });
  });
  it('a sync commit naming a descendant of the merge commit qualifies', () => {
    expect(qualifyDeployedCommit({ ...base, deployedMessage: sync('c'.repeat(12)), namedRelation: 'ahead' })).toEqual({ qualifies: true, via: 'sync_descends' });
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
