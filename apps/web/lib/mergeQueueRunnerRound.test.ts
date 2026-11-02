import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ queries: [] as Array<{ text: string; args: unknown[] }>, rows: [] as Array<{ payload: unknown }> }));
vi.mock("@fx/core/src/tenancy/withTenant.js", () => ({
  withTenant: async (_pool: unknown, _account: string, fn: (c: unknown) => unknown) => fn({ query: async (text: string, args: unknown[]) => (h.queries.push({ text, args }), { rows: h.rows }) }),
}));
vi.mock("./advanceReviewSteps", () => ({ findPrBody: async () => ({ ok: false, reason: "x" }), reviewLoadBody: async () => ({ ok: false, reason: "x" }) }));
vi.mock("./mergeQueueDeltaReview", () => ({ deltaReviewPorts: () => ({}), readEntryContext: async () => ({ reason: "x" }), readEntryWho: async () => ({ reason: "x" }) }));
vi.mock("./github/installationReconcile", () => ({ appUserPool: () => ({}) }));
vi.mock("./github/installationHttp", () => ({ readRepoAppLogin: async () => "bot" }));
vi.mock("./github/localOnlyHttp", () => ({ openForRepo: async () => ({}) }));
vi.mock("./github/runnerPullRequest", () => ({ createAppRunPullRequestPort: () => ({}) }));

import { completeRunnerEntryless, readFirstAttestation } from "./mergeQueueConflict";

/**
 * D#519 MQ4-e2-c2: the web side of the `runner_local` round. The attestation is the run's FIRST `conflict.attestation` event (two concurrent first `done`s can store two), read by the
 * round's own run id, so a follow-up child of a lost round (a different run, no key, no event) never reads as a conflict round. No cloud read of the code repository is added: the
 * adapter is built from the fence's documents and that event only (localOnlyGithub.test.ts and localOnlyHttp.test.ts pass unchanged).
 */
describe("the runner round's stored attestation", () => {
  it("reads the lowest-seq event of the run, then the lowest id, and only that one", async () => {
    h.queries.length = 0;
    h.rows = [{ payload: { head: "x" } }, { payload: { head: "y" } }];
    expect(await readFirstAttestation({} as never, "acc", "run-1")).toEqual({ head: "x" });
    expect(h.queries[0]!.text).toMatch(/ORDER BY seq ASC, id ASC LIMIT 1/);
    expect(h.queries[0]!.args).toEqual(["acc", "run-1", "conflict.attestation"]);
  });

  it("a run with no event (a follow-up child carries none) reads as nothing", async () => {
    h.rows = [];
    expect(await readFirstAttestation({} as never, "acc", "child-run")).toBeNull();
  });

  it("the round's attestation is looked up by the round row's run id and by nothing a child run supplies", () => {
    const src = readFileSync(new URL("./mergeQueueConflict.ts", import.meta.url), "utf8");
    expect(src).toMatch(/round\?\.runId \? await readFirstAttestation\(deps\.pool, accountId, round\.runId\)/);
    expect([...src.matchAll(/readFirstAttestation\(/g)]).toHaveLength(2);
  });

  it("a repository that is not runner_local is not this path's: nothing is read from GitHub", async () => {
    h.queries.length = 0;
    h.rows = [{ gh_owner: "acme", gh_name: "widgets", execution_mode: "sandbox" }] as never;
    const out = await completeRunnerEntryless({ pool: {} as never, worker: null, open: (async () => ({})) as never }, { id: "w", accountId: "acc", repoId: "r", workItemId: "w", prNumber: 1, headSha: "a".repeat(40), entryId: null, roundsUsed: 1 }, true);
    expect(out).toBeNull();
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0]!.text).toMatch(/FROM repos/);
  });
});
