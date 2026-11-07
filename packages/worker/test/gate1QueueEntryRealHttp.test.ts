import { generateKeyPairSync, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { InstallationTokenCache, MERGE_GATE_PERMISSIONS, MERGE_QUEUE_ENTRY_DOCUMENT, createInstallationHttp, type AccessTokenRequester } from "@fx/github";
import { ACTIONS_APP_ID, GATE1_DESCRIPTIONS, GATE1_WORKFLOW_CONTEXTS, attestQueueEntry, parseGate1AttestRepos } from "@fx/pipeline";
import type { GitHubHttp } from "../../pipeline/src/build/githubMergePort.js";
import { readGate1CreatorRest } from "../../pipeline/src/review/gate1Creator.js";
import { strictGithubFetch } from "../../github/test/helpers/strictGithub.js";
import { gate1World } from "../../pipeline/test/review/helpers/fakeGitHubLocal.js";
import { freshRepo, type FakeCheckRun } from "../../pipeline/test/review/helpers/fakeGitHubRest.js";
import { fakeGitHubQueueRest, type HostedQueueWorld } from "../../pipeline/test/review/helpers/fakeGitHubQueueRest.js";

/**
 * D#6 CLOUD-POSTS-FX-GATE1 PR 1e: the hosted queue-entry attester and the hosted merge gate's creator read through the REAL installation client
 * (`createInstallationHttp`, `merge_gate` kind, never opened with `allowGraphql`) over the strict GitHub fetch. Every call they make (the queue branches,
 * the base tip, the chain of entry commits, the pinned entry document, check runs, statuses, the status post) is proven to be one the production client sends, with the
 * merge_gate purpose's fixed token. Not faked faithfully: whether that token is granted these reads on the real repository (the staging probe checks).
 */
const H11 = "1b".repeat(20);
const H12 = "2c".repeat(20);
const E11 = "a1".repeat(20);
const E12 = "a2".repeat(20);
const MAIN = "e0".repeat(20);
const REPOS = parseGate1AttestRepos("acme/widgets-public");
const OURS = { __typename: "Bot", login: "fx-cloud-app[bot]" };

let appKeyPem: string;
beforeAll(() => {
  appKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
});

interface Trace {
  refused: string[];
  sent: string[];
  minted: Array<Record<string, string>>;
}

/** The production `merge_gate` client for one repository, whose transport is the given fake behind the strict GitHub fetch. */
function realClient(fake: GitHubHttp, trace: Trace): GitHubHttp {
  const requester: AccessTokenRequester = async (p) => {
    trace.minted.push({ ...(p.permissions as Record<string, string>) });
    return { token: "ghs_gate1", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: "read", ...p.permissions } as Record<string, string>, repositories: p.repositories ?? [] };
  };
  const open = createInstallationHttp({
    resolveInstallation: async () => ({ installationId: 42, appKind: "team" }),
    appCredentials: () => ({ appId: "12345", privateKeyPem: appKeyPem, webhookSecret: "unused" }),
    requester,
    cache: new InstallationTokenCache(),
    fetchImpl: strictGithubFetch((async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => (query[k] = v));
      trace.sent.push(`${init?.method ?? "GET"} ${url.pathname}`);
      const out = await fake.request({ method: (init?.method ?? "GET") as "GET", path: url.pathname, ...(Object.keys(query).length > 0 ? { query } : {}), ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) });
      return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch),
  });
  const opened = open("merge_gate", { repoId: randomUUID(), owner: "acme", name: "widgets-public" });
  return {
    async request(req) {
      try {
        return await (await opened).request(req);
      } catch (err) {
        trace.refused.push(`${(err as { reason?: string }).reason ?? (err as Error).name} ${req.method} ${req.path}`);
        throw err;
      }
    },
  };
}

const green = (): FakeCheckRun[] => GATE1_WORKFLOW_CONTEXTS.map((name) => ({ name, status: "completed", conclusion: "success", startedAt: "2026-11-07T09:00:00Z", app: { id: ACTIONS_APP_ID } }));

describe("hosted fx-gate1 on a queue entry, through the real merge_gate client", () => {
  it("success: queue branches, the entry commit, the pinned entry document, check runs and statuses are all sent, nothing refused, the fixed token", async () => {
    const s = freshRepo({ owner: "acme", name: "widgets-public", prNumber: 12, headSha: H12, checks: { [E12]: green() }, statuses: { [H11]: { "fx-gate1": "success" }, [H12]: { "fx-gate1": "success" } }, commitParents: { [E11]: [MAIN], [E12]: [E11] } });
    const q: HostedQueueWorld = {
      refs: [
        { ref: `refs/heads/gh-readonly-queue/main/pr-11-${MAIN}`, sha: E11 },
        { ref: `refs/heads/gh-readonly-queue/main/pr-12-${E11}`, sha: E12 },
      ],
      prs: { 11: { state: "OPEN", headRefOid: H11, entry: { id: "MQE_11", state: "AWAITING_CHECKS", position: 1 } }, 12: { state: "OPEN", headRefOid: H12, entry: { id: "MQE_12", state: "AWAITING_CHECKS", position: 2 } } },
      entryReads: [],
      baseTip: MAIN,
    };
    const trace: Trace = { refused: [], sent: [], minted: [] };
    const http = realClient(fakeGitHubQueueRest(s, gate1World({ creators: { [H11]: OURS, [H12]: OURS } }), q), trace);
    const out = await attestQueueEntry(http, { repos: REPOS, owner: "acme", name: "widgets-public", base: "main", prNumber: 12, baseSha: E11, entrySha: E12, ourLogin: async () => "fx-cloud-app[bot]", entryDocument: MERGE_QUEUE_ENTRY_DOCUMENT });
    expect(out).toEqual({ kind: "posted", state: "success" });
    expect(trace.refused).toEqual([]);
    expect(s.posts).toEqual([{ sha: E12, body: { state: "success", context: "fx-gate1", description: GATE1_DESCRIPTIONS.success } }]);
    expect(new Set(trace.sent)).toEqual(
      new Set([
        `GET /repos/acme/widgets-public/commits/${E12}/statuses`,
        "GET /repos/acme/widgets-public/git/matching-refs/heads/gh-readonly-queue/main",
        "GET /repos/acme/widgets-public/git/ref/heads/main",
        `GET /repos/acme/widgets-public/commits/${E12}`,
        `GET /repos/acme/widgets-public/commits/${E11}`,
        "POST /graphql",
        `GET /repos/acme/widgets-public/commits/${E12}/check-runs`,
        `GET /repos/acme/widgets-public/commits/${H11}/statuses`,
        `GET /repos/acme/widgets-public/commits/${H12}/statuses`,
        `POST /repos/acme/widgets-public/statuses/${E12}`,
      ]),
    );
    expect(q.entryReads.sort()).toEqual([11, 12]);
    expect(trace.minted.length).toBeGreaterThan(0);
    expect(trace.minted.every((p) => JSON.stringify(Object.keys(p).sort()) === JSON.stringify(Object.keys(MERGE_GATE_PERMISSIONS).sort()))).toBe(true);
  });

  it("the client refuses an unpinned document, and the pinned entry document for another repository: the attester never needs either", async () => {
    const trace: Trace = { refused: [], sent: [], minted: [] };
    const http = realClient({ request: async () => ({ status: 200, body: {} }) }, trace);
    await expect(http.request({ method: "POST", path: "/graphql", body: { query: "query { viewer { login } }", variables: {} } })).rejects.toThrow();
    await expect(http.request({ method: "POST", path: "/graphql", body: { query: MERGE_QUEUE_ENTRY_DOCUMENT, variables: { owner: "acme", name: "other", number: 12 } } })).rejects.toThrow();
    expect(trace.sent).toEqual([]);
  });

  it("the hosted merge gate's creator read (REST statuses) is sent by the client and reads our bot", async () => {
    const s = freshRepo({ owner: "acme", name: "widgets-public", prNumber: 12, headSha: H12, statuses: { [H12]: { "fx-gate1": "success" } } });
    const trace: Trace = { refused: [], sent: [], minted: [] };
    const http = realClient(fakeGitHubQueueRest(s, gate1World({ creators: { [H12]: OURS } }), { refs: [], prs: {}, entryReads: [] }), trace);
    expect(await readGate1CreatorRest(http, { owner: "acme", name: "widgets-public", sha: H12 }, "fx-cloud-app[bot]")).toEqual({ state: "SUCCESS", ours: true });
    expect(trace).toMatchObject({ refused: [], sent: [`GET /repos/acme/widgets-public/commits/${H12}/statuses`] });
  });
});
