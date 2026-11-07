import { generateKeyPairSync, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { InstallationTokenCache, MERGE_GATE_PERMISSIONS, createInstallationHttp, type AccessTokenRequester } from "@fx/github";
import type { GithubClient } from "@fx/runner-cloud";
import { ACTIONS_APP_ID, GATE1_DESCRIPTIONS, GATE1_WORKFLOW_CONTEXTS, attestGate1Head, parseGate1AttestRepos } from "@fx/pipeline";
import type { GitHubHttp } from "../../pipeline/src/build/githubMergePort.js";
import { strictGithubFetch } from "../../github/test/helpers/strictGithub.js";
import { fakeGitHubLocal, gate1World } from "../../pipeline/test/review/helpers/fakeGitHubLocal.js";
import { fakeGitHubRest, freshRepo, type FakeCheckRun, type FakeRepoState } from "../../pipeline/test/review/helpers/fakeGitHubRest.js";

/**
 * D#6 CLOUD-POSTS-FX-GATE1 (TL ruling 11-07 01:25): the attester through the REAL GitHub installation client (`createInstallationHttp`, `merge_gate`
 * kind, the token cache and requester, every path, method and GraphQL rule it keeps) over the strict GitHub fetch, on both paths:
 *  - hosted: the plain `merge_gate` client, never opened with `allowGraphql`; every read is REST and the client sends each one;
 *  - runner_local: runner-cloud's fence (`gate1Attest`, without A10) in front of the real client opened with `allowGraphql`, as `openForRepo` builds it.
 * The tests use the pipeline's strict fakes behind the client, so every call the attester makes is proven to be one the production client sends.
 * Not faked faithfully: whether the merge_gate token is granted these reads and writes on the real repository (staging probe 6 checks that).
 */
const HEAD = "c".repeat(40);
const PR = 12;
const REPOS = parseGate1AttestRepos("acme/widgets-public");
const runs = (startedAt: string): FakeCheckRun[] => GATE1_WORKFLOW_CONTEXTS.map((name) => ({ name, status: "completed", conclusion: "success", startedAt, app: { id: ACTIONS_APP_ID } }));

let appKeyPem: string;
beforeAll(() => {
  appKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
});

interface Trace {
  refused: string[];
  sent: string[];
  minted: Array<Record<string, string>>;
}
type Answer = (req: { method: string; path: string; query?: Record<string, string>; accept?: string; body?: unknown }) => Promise<{ status: number; body: unknown }>;

/** The production `merge_gate` client for one repository; its transport is `answer` behind the strict GitHub fetch. */
function realClient(owner: string, name: string, answer: Answer, trace: Trace, opts: { allowGraphql?: boolean } = {}): GitHubHttp {
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
      const headers = (init?.headers ?? {}) as Record<string, string>;
      trace.sent.push(`${init?.method ?? "GET"} ${url.pathname}`);
      const out = await answer({ method: init?.method ?? "GET", path: url.pathname, ...(Object.keys(query).length > 0 ? { query } : {}), ...(headers.accept ? { accept: headers.accept } : {}), ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) });
      return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch),
  });
  const opened = open("merge_gate", { repoId: randomUUID(), owner, name, ...(opts.allowGraphql ? { allowGraphql: true } : {}) });
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

const repo = (over: Partial<FakeRepoState> = {}) => freshRepo({ owner: "acme", name: "widgets-public", prNumber: PR, headSha: HEAD, files: [{ filename: "src/ui/button.tsx", status: "modified" }], checks: { [HEAD]: runs("2026-11-07T09:00:00Z") }, ...over });
const readHeadOf = (http: GitHubHttp) => async () => ((await http.request({ method: "GET", path: `/repos/acme/widgets-public/pulls/${PR}` })).body as { head: { sha: string } }).head.sha;

describe("the fx-gate1 attester through the real installation client", () => {
  it("hosted: label, wait, then success, every call sent by the merge_gate client and no GraphQL at all", async () => {
    const s = repo();
    const w = gate1World({ now: "2026-11-07T10:00:00Z" });
    const fake = fakeGitHubRest(s, { gate1: w });
    const trace: Trace = { refused: [], sent: [], minted: [] };
    const http = realClient("acme", "widgets-public", (r) => fake.request({ method: r.method as "GET", path: r.path, ...(r.query ? { query: r.query } : {}), ...(r.body !== undefined ? { body: r.body } : {}) }), trace);
    const run = () => attestGate1Head(http, { repos: REPOS, owner: "acme", name: "widgets-public", number: PR, sha: HEAD, ourLogin: async () => "fx-cloud-app[bot]", readHead: readHeadOf(http) });
    expect(await run()).toEqual({ kind: "label_added" });
    s.checks[HEAD] = runs("2026-11-07T10:05:00Z");
    expect(await run()).toEqual({ kind: "posted", state: "success" });
    expect(await run()).toEqual({ kind: "already" });
    expect(trace.refused).toEqual([]);
    expect(s.posts).toEqual([{ sha: HEAD, body: { state: "success", context: "fx-gate1", description: GATE1_DESCRIPTIONS.success } }]);
    expect(new Set(trace.sent)).toEqual(
      new Set([`GET /repos/acme/widgets-public/commits/${HEAD}/statuses`, `GET /repos/acme/widgets-public/pulls/${PR}/files`, `GET /repos/acme/widgets-public/pulls/${PR}`, `GET /repos/acme/widgets-public/issues/${PR}/events`, `GET /repos/acme/widgets-public/commits/${HEAD}/check-runs`, `POST /repos/acme/widgets-public/issues/${PR}/labels`, `POST /repos/acme/widgets-public/statuses/${HEAD}`]),
    );
    // The token asked for is the merge_gate purpose's fixed set, nothing added for the attester.
    expect(trace.minted.length).toBeGreaterThan(0);
    // By value, not just by name: a token that asked for `statuses: read` would fail every post.
    expect(trace.minted).toEqual(trace.minted.map(() => ({ ...MERGE_GATE_PERMISSIONS })));
    expect(trace.minted[0]).toMatchObject({ statuses: "write", pull_requests: "write", checks: "read" });
  });

  it("hosted: the client still refuses what it always refused (a GraphQL document that is not pinned), so the attester never needs one", async () => {
    const trace: Trace = { refused: [], sent: [], minted: [] };
    const http = realClient("acme", "widgets-public", async () => ({ status: 200, body: {} }), trace);
    await expect(http.request({ method: "POST", path: "/graphql", body: { query: "query { viewer { login } }", variables: {} } })).rejects.toThrow();
    expect(trace.sent).toEqual([]);
  });

  it("runner_local: the fence in front of the real client; A17, A1, A16, A15, A14 then A7, nothing refused by either", async () => {
    const s = repo({ runBranch: "fx/run-g1" });
    const w = gate1World({ now: "2026-11-07T10:00:00Z" });
    const trace: Trace = { refused: [], sent: [], minted: [] };
    const local = fakeGitHubLocal(s, {
      exclude: ["A10"],
      gate1: w,
      transport: (inner: GithubClient): GithubClient => ({
        request: (req) =>
          realClient("acme", "widgets-public", (r) => inner.request({ method: r.method, path: r.path, ...(r.query ? { query: r.query } : {}), headers: { accept: r.accept ?? "" }, ...(r.body !== undefined ? { body: r.body } : {}) }), trace, { allowGraphql: true }).request(req as Parameters<GitHubHttp["request"]>[0]),
      }),
    });
    const run = () => attestGate1Head(local.http, { repos: REPOS, owner: "acme", name: "widgets-public", number: PR, sha: HEAD, ourLogin: async () => "fx-cloud-app[bot]", readHead: async () => s.headSha });
    expect(await run()).toEqual({ kind: "label_added" });
    s.checks[HEAD] = runs("2026-11-07T10:05:00Z");
    expect(await run()).toEqual({ kind: "posted", state: "success" });
    expect({ refused: trace.refused, fence: local.refused, fake: local.denied }).toEqual({ refused: [], fence: [], fake: [] });
    expect(local.calls.map((c) => c.label)).toEqual(["A17", "A1 PullRequestFiles", "A16", "A15", "A14", "A17", "A1 PullRequestFiles", "A16", "A15", "A7"]);
    expect(s.posts.map((p) => p.body)).toEqual([{ state: "success", context: "fx-gate1", description: GATE1_DESCRIPTIONS.success }]);
  });
});
