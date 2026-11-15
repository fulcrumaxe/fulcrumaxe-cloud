import { beforeEach, describe, expect, it } from "vitest";
import { clearMergeQueueModeCache, createGitHubMergeGatePort } from "../../src/build/githubMergePort.js";
import {
  DEQUEUE_PULL_REQUEST_DOCUMENT,
  ENABLE_AUTO_MERGE_DOCUMENT,
  ENQUEUE_PULL_REQUEST_DOCUMENT,
  ENQUEUE_PULL_REQUEST_JUMP_DOCUMENT,
  MERGE_QUEUE_ENTRY_DOCUMENT,
  MERGE_QUEUE_READ_DOCUMENT,
} from "../../../github/src/mergeGateGraphql.js";
import { fakeGitHubRest, freshRepo } from "../review/helpers/fakeGitHubRest.js";

/**
 * TWO-LANE-QUEUE: the port's jump against the strict REST-level fake. The fake answers `POST /graphql` only for pinned documents (as the hosted `merge_gate` client does),
 * and for the jumping document it enforces what GitHub does: an actor that is not a bypass actor of the ruleset is refused with the same FORBIDDEN answer as any refused
 * write, and an allowed jump rebuilds every entry already in progress. What it cannot fake faithfully: GitHub's real ordering of the queue after a jump, and the exact
 * text of a transient error; the fake answers position 1 and a generic error class.
 */
const DOCS = { read: MERGE_QUEUE_READ_DOCUMENT, enqueue: ENQUEUE_PULL_REQUEST_DOCUMENT, enqueueJump: ENQUEUE_PULL_REQUEST_JUMP_DOCUMENT, autoMerge: ENABLE_AUTO_MERGE_DOCUMENT, dequeue: DEQUEUE_PULL_REQUEST_DOCUMENT, entry: MERGE_QUEUE_ENTRY_DOCUMENT };

beforeEach(() => clearMergeQueueModeCache());

const portOver = (s: ReturnType<typeof freshRepo>, docs: Record<string, string> = DOCS) =>
  createGitHubMergeGatePort({ http: fakeGitHubRest(s), resolveRepo: async () => ({ owner: s.owner, name: s.name }), markReadyForHumanMerge: async () => undefined, queueDocuments: docs as typeof DOCS });
const ref = (s: ReturnType<typeof freshRepo>) => ({ repoId: "r", prNumber: s.prNumber });
const kinds = (s: ReturnType<typeof freshRepo>) => s.mergeQueue!.mutations.map((m) => m.kind);

describe("enqueuePullRequest with jump", () => {
  it("a cloud pull request that asks for the jump, from an actor the ruleset lets bypass: one jumping mutation, position 1, the entries in progress are rebuilt", async () => {
    const s = freshRepo({ mergeQueue: { exists: true, jumpAllowed: true, inProgress: 3, mutations: [] } });
    const out = await portOver(s).enqueuePullRequest!(ref(s), { expectedHeadOid: s.headSha, jump: true });
    expect(out).toEqual({ enqueued: true, via: "queue", entryId: "MQE_kwDOfake1", position: 1, jump: "applied" });
    expect(kinds(s)).toEqual(["enqueue_jump"]);
    expect(s.mergeQueue!.mutations[0]!.variables).toEqual({ pullRequestId: `PR_kwDOfake${s.prNumber}`, expectedHeadOid: s.headSha });
    expect(s.mergeQueue!.rebuilt).toBe(3);
  });

  it("no jump asked for (every pull request that is not the cloud's own, and the cloud's when the rule says none): the plain document only, nothing rebuilt", async () => {
    const s = freshRepo({ mergeQueue: { exists: true, jumpAllowed: true, inProgress: 3, mutations: [] } });
    const out = await portOver(s).enqueuePullRequest!(ref(s), { expectedHeadOid: s.headSha });
    expect(out).toEqual({ enqueued: true, via: "queue", entryId: "MQE_kwDOfake1", position: 1 });
    expect(kinds(s)).toEqual(["enqueue"]);
    expect(s.mergeQueue!.rebuilt ?? 0).toBe(0);
  });

  it("jump: false is the plain enqueue too", async () => {
    const s = freshRepo({ mergeQueue: { exists: true, jumpAllowed: true, mutations: [] } });
    await portOver(s).enqueuePullRequest!(ref(s), { expectedHeadOid: s.headSha, jump: false });
    expect(kinds(s)).toEqual(["enqueue"]);
  });

  it("a port handed no jumping document never jumps, whatever the caller asks", async () => {
    const s = freshRepo({ mergeQueue: { exists: true, jumpAllowed: true, mutations: [] } });
    const { enqueueJump: _omit, ...withoutJump } = DOCS;
    const out = await portOver(s, withoutJump).enqueuePullRequest!(ref(s), { expectedHeadOid: s.headSha, jump: true });
    expect(out).toMatchObject({ enqueued: true, via: "queue" });
    expect(out).not.toHaveProperty("jump");
    expect(kinds(s)).toEqual(["enqueue"]);
  });

  it("an actor the ruleset does not let bypass is refused the jump (FORBIDDEN); the same pull request is enqueued once more without it, and the outcome says refused", async () => {
    const s = freshRepo({ mergeQueue: { exists: true, jumpAllowed: false, mutations: [] } });
    const out = await portOver(s).enqueuePullRequest!(ref(s), { expectedHeadOid: s.headSha, jump: true });
    expect(out).toMatchObject({ enqueued: true, via: "queue", jump: "refused" });
    expect(kinds(s)).toEqual(["enqueue_jump", "enqueue"]);
    expect(s.mergeQueue!.rebuilt ?? 0).toBe(0);
  });

  it("a transient host error on the jump is retried once without it, the same way", async () => {
    const s = freshRepo({ mergeQueue: { exists: true, jumpAllowed: true, jumpError: true, mutations: [] } });
    const out = await portOver(s).enqueuePullRequest!(ref(s), { expectedHeadOid: s.headSha, jump: true });
    expect(out).toMatchObject({ enqueued: true, via: "queue", jump: "refused" });
    expect(kinds(s)).toEqual(["enqueue_jump", "enqueue"]);
  });

  it("a non-200 answer to the jump (a gateway error) is a refusal like a GraphQL one: one plain enqueue follows and the outcome says refused", async () => {
    const s = freshRepo({ mergeQueue: { exists: true, jumpAllowed: true, jumpStatus: 502, mutations: [] } });
    const out = await portOver(s).enqueuePullRequest!(ref(s), { expectedHeadOid: s.headSha, jump: true });
    expect(out).toMatchObject({ enqueued: true, via: "queue", jump: "refused" });
    expect(kinds(s)).toEqual(["enqueue_jump", "enqueue"]);
  });

  it("a head that moved is final: no retry, no second mutation, head_moved", async () => {
    const s = freshRepo({ mergeQueue: { exists: true, jumpAllowed: true, mutations: [] } });
    const out = await portOver(s).enqueuePullRequest!(ref(s), { expectedHeadOid: "d".repeat(40), jump: true });
    expect(out).toEqual({ enqueued: false, reason: "head_moved" });
    expect(kinds(s)).toEqual(["enqueue_jump"]);
  });

  it("a refused jump and a refused plain enqueue (the app may not use the queue at all) fall to auto-merge exactly as the plain path does; no jump is reported", async () => {
    const s = freshRepo({ mergeQueue: { exists: true, jumpAllowed: false, enqueue: "forbidden", mutations: [] } });
    const out = await portOver(s).enqueuePullRequest!(ref(s), { expectedHeadOid: s.headSha, jump: true });
    expect(out).toEqual({ enqueued: true, via: "auto_merge", entryId: null, position: null });
    expect(kinds(s)).toEqual(["enqueue_jump", "enqueue", "auto_merge"]);
  });

  it("a jumping document that is not the pinned one is refused like the hosted client does, and nothing reaches the host", async () => {
    const s = freshRepo({ mergeQueue: { exists: true, jumpAllowed: true, mutations: [] } });
    const port = portOver(s, { ...DOCS, enqueueJump: ENQUEUE_PULL_REQUEST_JUMP_DOCUMENT.replace("jump: true", "jump: false") });
    await expect(port.enqueuePullRequest!(ref(s), { expectedHeadOid: s.headSha, jump: true })).rejects.toThrow("path_refused");
    expect(s.mergeQueue!.mutations).toEqual([]);
  });

  it("a malformed head is refused before any call, jump or not", async () => {
    const s = freshRepo({ mergeQueue: { exists: true, jumpAllowed: true, mutations: [] } });
    await expect(portOver(s).enqueuePullRequest!(ref(s), { expectedHeadOid: "nope", jump: true })).rejects.toThrow("malformed expected head");
    expect(s.mergeQueue!.mutations).toEqual([]);
  });
});
