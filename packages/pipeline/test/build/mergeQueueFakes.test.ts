import { beforeEach, describe, expect, it } from "vitest";
import { clearMergeQueueModeCache, createGitHubMergeGatePort } from "../../src/build/githubMergePort.js";
import {
  DEQUEUE_PULL_REQUEST_DOCUMENT,
  ENABLE_AUTO_MERGE_DOCUMENT,
  ENQUEUE_PULL_REQUEST_DOCUMENT,
  MERGE_QUEUE_ENTRY_DOCUMENT,
  MERGE_QUEUE_READ_DOCUMENT,
} from "../../../github/src/mergeGateGraphql.js";
import { fakeGitHubRest, freshRepo } from "../review/helpers/fakeGitHubRest.js";
import { FakeGitHub } from "./helpers/fakeGitHub.js";

/**
 * D#694 B6-1: the two strict fakes that model the new calls. The REST-level fake answers the pinned documents the way the hosted client lets them through
 * (anything else throws), and the port-level fake is what B6-2 onwards will drive the pipeline with.
 */
const DOCS = { read: MERGE_QUEUE_READ_DOCUMENT, enqueue: ENQUEUE_PULL_REQUEST_DOCUMENT, autoMerge: ENABLE_AUTO_MERGE_DOCUMENT, dequeue: DEQUEUE_PULL_REQUEST_DOCUMENT, entry: MERGE_QUEUE_ENTRY_DOCUMENT };
const ENTRY = { id: "MQE_kwDOfake1", state: "QUEUED", position: 1 };

beforeEach(() => clearMergeQueueModeCache());

function portOver(state: ReturnType<typeof freshRepo>) {
  return createGitHubMergeGatePort({ http: fakeGitHubRest(state), resolveRepo: async () => ({ owner: state.owner, name: state.name }), markReadyForHumanMerge: async () => undefined, queueDocuments: DOCS });
}

describe("fakeGitHubRest: the entry read and the dequeue", () => {
  const ref = (s: ReturnType<typeof freshRepo>) => ({ repoId: "r", prNumber: s.prNumber });

  it("the entry read tells the queue entry apart from the queue read (it is not answered as a queue)", async () => {
    const s = freshRepo({ mergeQueue: { exists: true, entry: ENTRY, mutations: [] } });
    expect(await portOver(s).getQueueEntry!(ref(s))).toEqual({ state: "open", merged: false, headSha: s.headSha, entry: { id: "MQE_kwDOfake1", state: "queued", position: 1 } });
  });

  it("a dequeue removes the entry it names; the next read shows none, and a second dequeue is not_queued", async () => {
    const s = freshRepo({ mergeQueue: { exists: true, entry: ENTRY, mutations: [] } });
    const port = portOver(s);
    expect(await port.dequeuePullRequest!(ref(s))).toEqual({ dequeued: true, entryId: "MQE_kwDOfake1" });
    expect((await port.getQueueEntry!(ref(s))).entry).toBeNull();
    expect(await port.dequeuePullRequest!(ref(s))).toEqual({ dequeued: false, reason: "not_queued" });
    expect(s.mergeQueue!.mutations.map((m) => m.kind)).toEqual(["dequeue", "dequeue"]);
    expect(s.mergeQueue!.mutations[0]!.variables).toEqual({ pullRequestId: `PR_kwDOfake${s.prNumber}` });
  });

  it("a forbidden dequeue is unavailable and the entry stays", async () => {
    const s = freshRepo({ mergeQueue: { exists: true, entry: ENTRY, dequeue: "forbidden", mutations: [] } });
    const port = portOver(s);
    expect(await port.dequeuePullRequest!(ref(s))).toEqual({ dequeued: false, reason: "unavailable" });
    expect((await port.getQueueEntry!(ref(s))).entry).not.toBeNull();
  });

  it("the entry read follows the pull request: merged is closed with the flag set", async () => {
    const s = freshRepo({ merged: true, state: "closed", mergeQueue: { exists: true, entry: null, mutations: [] } });
    expect(await portOver(s).getQueueEntry!(ref(s))).toMatchObject({ state: "closed", merged: true, entry: null });
  });

  it("a document that is not pinned is refused like the hosted client does, and the call is not recorded", async () => {
    const s = freshRepo({ mergeQueue: { exists: true, entry: ENTRY, mutations: [] } });
    const port = createGitHubMergeGatePort({ http: fakeGitHubRest(s), resolveRepo: async () => ({ owner: s.owner, name: s.name }), markReadyForHumanMerge: async () => undefined, queueDocuments: { ...DOCS, dequeue: `${DOCS.dequeue} ` } });
    await expect(port.dequeuePullRequest!(ref(s))).rejects.toThrow("path_refused");
    expect(s.mergeQueue!.mutations).toEqual([]);
  });
});

describe("FakeGitHub: the port-level fake", () => {
  const pr = { repoId: "r", prNumber: 3 };
  const base = { pr: { headSha: "a".repeat(40), state: "open" as const, merged: false, draft: false, body: "", labels: [], comments: [] } };

  it("has neither method without a queue (a port from before the queue)", () => {
    const fake = new FakeGitHub(base);
    expect(fake.dequeuePullRequest).toBeUndefined();
    expect(fake.getQueueEntry).toBeUndefined();
  });

  it("with a queue it records the calls and answers the defaults or what the test sets", async () => {
    const fake = new FakeGitHub({ ...base, queueMode: "queue" });
    expect(await fake.getQueueEntry!(pr)).toEqual({ state: "open", merged: false, headSha: "a".repeat(40), entry: { id: "MQE_kwDOtest1", state: "queued", position: 1 } });
    expect(await fake.dequeuePullRequest!(pr)).toEqual({ dequeued: true, entryId: "MQE_kwDOtest1" });
    expect(fake.entryReads).toEqual([3]);
    expect(fake.dequeueCalls).toEqual([3]);
    const moved = new FakeGitHub({ ...base, queueMode: "queue", dequeue: { dequeued: false, reason: "not_queued" }, queueEntry: (f) => ({ state: "open", merged: false, headSha: f.pr.headSha, entry: null }) });
    moved.pr.headSha = "b".repeat(40);
    expect(await moved.dequeuePullRequest!(pr)).toEqual({ dequeued: false, reason: "not_queued" });
    expect((await moved.getQueueEntry!(pr)).headSha).toBe("b".repeat(40));
  });
});
