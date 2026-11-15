/**
 * D#694 B7-1: the two GraphQL documents the local runner sends to GitHub for a merge order whose code repository may merge through a queue. The runner depends on
 * this package alone, so these are copies of `@fulcrumaxe/github`'s `MERGE_QUEUE_READ_DOCUMENT` and `ENQUEUE_PULL_REQUEST_DOCUMENT`; a test in that package holds each
 * string byte-equal to the original, and the cloud's fence for the same reads (`runner-cloud` `MERGE_QUEUE_READ_DOCUMENTS`) is held equal the same way.
 */
export const MERGE_QUEUE_READ_DOCUMENT = "query($owner: String!, $name: String!, $branch: String!) { repository(owner: $owner, name: $name) { mergeQueue(branch: $branch) { id } } }";
export const ENQUEUE_PULL_REQUEST_DOCUMENT =
  "mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) { enqueuePullRequest(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid }) { mergeQueueEntry { id position } } }";
/**
 * TWO-LANE-QUEUE: the jumping enqueue, held byte-equal to `@fulcrumaxe/github`'s `ENQUEUE_PULL_REQUEST_JUMP_DOCUMENT` by the same test. The runner never sends it: it is here so
 * the cloud's fence for a `runner_local` repository (which refuses every write document) can be tested against the exact string, and so nobody adds a second copy.
 */
export const ENQUEUE_PULL_REQUEST_JUMP_DOCUMENT =
  "mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) { enqueuePullRequest(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid, jump: true }) { mergeQueueEntry { id position } } }";
