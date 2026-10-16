import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  decideRunnerGitRequest,
  InstallationTokenCache,
  type AccessTokenRequester,
  type RunnerBoundBranchResolver,
  type RunnerCloneBudget,
  type RunnerGitDecisionDeps,
  type RunnerGitResolution,
  type RunnerGitTicketClaims,
} from "../src/index.js";
import { captureRealGitBodies, type RealGitBodies } from "./helpers/realGitBodies.js";

/**
 * D#599 PL-2b-2 (security model 3): a ticket that names the item's pull request branch is honoured only while the run is still bound to exactly that
 * branch, and the proxy asks on every request. The push body is the REAL installed git's push of `fx/issue-7`.
 */
const ITEM = "fx/issue-7";
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const MINTED = ["ghs", "_", "r".repeat(36)].join("");
const RUN = "0b1c2d3e-0000-4000-8000-000000000001";

const ticket = (ref: string): RunnerGitTicketClaims => ({
  issuer: "https://cloud.example.test",
  audience: "https://gh-proxy.example.test/api/gh-proxy",
  runnerId: "00000000-0000-4000-8000-0000000000a1",
  accountId: "00000000-0000-4000-8000-0000000000a2",
  runId: RUN,
  leaseGeneration: 2,
  repo: { id: "00000000-0000-4000-8000-0000000000a3", owner: "acme", name: "widgets" },
  ref,
  jti: "00000000-0000-4000-8000-0000000000a4",
  issuedAt: Math.floor(NOW / 1000),
  expiresAt: Math.floor(NOW / 1000) + 300,
});

const GRANT: RunnerGitResolution = { verdict: "ok", role: "executor", product: "team", installationId: 9, appKind: "team", owner: "acme", repo: "widgets" };

let bodies: RealGitBodies;
let privateKeyPem: string;
beforeAll(async () => {
  bodies = await captureRealGitBodies(ITEM, "fx/issue-8");
  privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })
    .privateKey as unknown as string;
}, 120_000);
afterAll(async () => {
  await bodies?.close();
});

function deps(bound: RunnerBoundBranchResolver | undefined): RunnerGitDecisionDeps & { requester: ReturnType<typeof vi.fn> } {
  const budget: RunnerCloneBudget = { isSpent: vi.fn(async () => false), record: vi.fn(async () => false) };
  const requester = vi.fn<AccessTokenRequester>(async () => ({ token: MINTED, expiresAt: new Date(NOW + 3600_000).toISOString() }));
  return {
    resolveRunnerGit: vi.fn(async () => GRANT),
    ...(bound ? { resolveBoundBranch: bound } : {}),
    appCredentials: () => ({ appId: "app-1", privateKeyPem, webhookSecret: "unused" }),
    tokenCache: new InstallationTokenCache(),
    accessTokenRequester: requester,
    cloneBudget: budget,
    now: () => NOW,
    requester,
  };
}
const push = (ref: string) => ({ path: "/acme/widgets.git/git-receive-pack", method: "POST", query: [] as Array<[string, string]>, rawBody: bodies.push.body, contentEncoding: null, ticket: ticket(ref) });

describe("a ticket for the item's pull request branch", () => {
  it("is honoured while the run is bound to exactly that branch, and the question is asked about this run", async () => {
    const bound = vi.fn(async () => ITEM);
    const d = deps(bound);
    expect(await decideRunnerGitRequest(push(ITEM), d)).toMatchObject({ allow: true });
    expect(bound).toHaveBeenCalledWith({ accountId: ticket(ITEM).accountId, runId: RUN });
  });

  it("is refused when the run is bound to another branch, to none, or the answer cannot be had; nothing is minted", async () => {
    for (const answer of ["fx/issue-8", null] as const) {
      const d = deps(vi.fn(async () => answer));
      expect(await decideRunnerGitRequest(push(ITEM), d)).toEqual({ allow: false, status: 403, reason: "runner_branch_unbound" });
      expect(d.requester).not.toHaveBeenCalled();
    }
    const none = deps(undefined);
    expect(await decideRunnerGitRequest(push(ITEM), none)).toEqual({ allow: false, status: 403, reason: "runner_branch_unbound" });
    expect(none.requester).not.toHaveBeenCalled();
  });

  it("is checked on every request, so a binding that stopped holding stops a ticket signed while it did", async () => {
    let answer: string | null = ITEM;
    const d = deps(vi.fn(async () => answer));
    expect((await decideRunnerGitRequest(push(ITEM), d)).allow).toBe(true);
    answer = null;
    expect((await decideRunnerGitRequest(push(ITEM), d)).allow).toBe(false);
  });

  it("is not asked for a run branch ticket, which has no binding to check", async () => {
    const bound = vi.fn(async () => null);
    const runBranch = `fx/${RUN}-g2`;
    const d = deps(bound);
    // The body pushes the item branch, so the policy (not the binding) refuses it; the point is that the binding was never consulted.
    expect(await decideRunnerGitRequest(push(runBranch), d)).toMatchObject({ allow: false, reason: "runner_policy_denied" });
    expect(bound).not.toHaveBeenCalled();
  });
});
