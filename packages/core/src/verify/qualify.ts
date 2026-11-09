/**
 * D#6 V1: does the commit the staging app reports contain a merge? Pure; the caller supplies what it read (the app's reported commit and, for a
 * two-plane repository, that commit's message and the host's answer to "how does the code-plane commit it names relate to the merge commit").
 *
 * A deployed commit qualifies for a merge when it is the merge commit itself, or when the deployment is the private sync commit whose message names a code-plane commit
 * (`Sync private main with code-plane/main (<12 hex>)`) and that commit is the merge commit or a descendant of it. Anything else (a sibling, an older commit, a message
 * that does not parse, a relation that could not be read) does not qualify, and the row ends `unverified: commit_not_deployed`.
 */
export type CommitRelation = 'identical' | 'ahead' | 'behind' | 'diverged' | 'unknown';
export type QualifyVia = 'same_commit' | 'sync_identical' | 'sync_descends';
export type QualifyResult = { qualifies: true; via: QualifyVia } | { qualifies: false; reason: 'commit_not_deployed' };

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SYNC_FIRST_LINE = /^Sync private main with code-plane\/main \(([0-9a-f]{12})\)$/;

/** The 12-hex code-plane prefix a sync commit's message names. Only the first line is read, and only the exact form. */
export function parseSyncMessage(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const first = message.slice(0, 2000).split('\n', 1)[0]!.replace(/\r$/, '');
  const m = SYNC_FIRST_LINE.exec(first);
  return m === null ? null : m[1]!;
}

export interface QualifyInput {
  /** The commit the app reported. */
  deployed: string;
  /** The merge commit of the row. */
  mergeSha: string;
  /** The repository has a private plane that syncs from the code plane. */
  twoPlane: boolean;
  /** The deployed commit's message, when the caller read it. */
  deployedMessage?: string | null;
  /**
   * The FULL id of the code-plane commit the deployed commit names: the host's own second parent (`genuineSyncCommit(...).named`), never text from the message. It equals the
   * merge commit only when the two ids are equal in full; the message's 12 hex alone never makes a commit the merge commit. Absent: the "names the merge commit" case cannot be
   * established and only the relation can qualify.
   */
  namedCommit?: string;
  /** How the code-plane commit the message names relates to the merge commit (`ahead`: it is a descendant). `unknown` when it was not read. */
  namedRelation?: CommitRelation;
}

/**
 * For the caller (the V3a sweep): this function trusts the first line of the message it is given. Before applying the sync rule the caller must confirm that the
 * deployed commit is a genuine sync commit (`genuineSyncCommit` below: a merge commit whose second parent is the commit the message names), and must read
 * `namedRelation` from the host, never from the message. A crafted message on a commit that is not a sync commit must not reach this rule.
 */
export function qualifyDeployedCommit(input: QualifyInput): QualifyResult {
  const no: QualifyResult = { qualifies: false, reason: 'commit_not_deployed' };
  const deployed = typeof input.deployed === 'string' ? input.deployed.toLowerCase() : '';
  const merge = typeof input.mergeSha === 'string' ? input.mergeSha.toLowerCase() : '';
  if (!SHA_RE.test(deployed) || !SHA_RE.test(merge)) return no;
  if (deployed === merge) return { qualifies: true, via: 'same_commit' };
  if (!input.twoPlane) return no;
  const named = parseSyncMessage(input.deployedMessage);
  if (named === null) return no;
  // Equal in FULL (CWE-1023): a 12-hex prefix is 48 bits, so a different commit can share it. The host's second parent must be the merge commit itself, and it must be the
  // commit the message names. Anything else is asked of the host as a relation, which only `ahead` (a descendant) can satisfy; a relation alone cannot make a different commit identical.
  const namedFull = typeof input.namedCommit === 'string' ? input.namedCommit.toLowerCase() : '';
  if (SHA_RE.test(namedFull) && namedFull.startsWith(named) && namedFull === merge) return { qualifies: true, via: 'sync_identical' };
  if (input.namedRelation === 'ahead') return { qualifies: true, via: 'sync_descends' };
  return no;
}

/** What the host says about a commit: its parents (full ids, first parent first) and its message. */
export interface CommitFacts {
  parents: readonly string[];
  message: string;
}

/**
 * Is this commit a genuine sync commit of the private plane, and which full code-plane commit does it name? The plane sync records its work as a merge commit: the first
 * parent is the private plane's own previous commit, the second is the code-plane commit the message names (by its first 12 hex). A message alone proves nothing, so a
 * commit counts only with exactly two parents, a message that parses, and a second parent that starts with the 12 hex the message names. Anything else (one parent with a
 * copied message, a merge whose second parent is another commit, three parents) answers null and the caller must not apply the sync rule to it. The id returned is the
 * host's own parent, never text from the message: it is what the caller compares with the merge commit.
 */
export function genuineSyncCommit(commit: CommitFacts | null): { named: string } | null {
  if (commit === null || !Array.isArray(commit.parents) || commit.parents.length !== 2) return null;
  const prefix = parseSyncMessage(commit.message);
  const first = typeof commit.parents[0] === 'string' ? commit.parents[0].toLowerCase() : '';
  const second = typeof commit.parents[1] === 'string' ? commit.parents[1].toLowerCase() : '';
  if (prefix === null || !SHA_RE.test(first) || !SHA_RE.test(second) || first === second || !second.startsWith(prefix)) return null;
  return { named: second };
}
