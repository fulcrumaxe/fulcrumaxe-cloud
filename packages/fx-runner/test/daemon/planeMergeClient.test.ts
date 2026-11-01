import { describe, expect, it } from "vitest";
import { PLANE_MERGE_CLAIM_PATH, PLANE_MERGE_REPORT_PATH, PLANE_MERGE_VERIFY_PATH, PlaneMergeClaimMessage, PlaneMergeReportMessage, PlaneMergeVerifyMessage } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient, type ClaimResult } from "../../src/daemon/client.js";
import { pollLoop } from "../../src/daemon/pollLoop.js";
import { generateRunnerKey } from "../../src/keys.js";
import { RUNNER_BUILD_CAPABILITIES } from "../../src/version.js";
import { OPEN_GATE } from "../helpers/openGate.js";
import { instantClock } from "../helpers/manualClock.js";

/** D#6 PUBLIC-MERGE PR3: the three signed calls of a merge order with the replies the cloud's routes give, the claim flag, and the poll loop's hook. */
const ORDER = "0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f";
const TOKEN = ["ghs", "clientmergevalue00000001"].join("_");
const HEAD = "a".repeat(40);
const errorBody = (code: string): unknown => ({ error: { code, message: "x" } });
const claimedBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  order_id: ORDER, lease_generation: 1, code_repo: "acme/widgets", pr_number: 7, public_branch: "fx/p-11111111-2222-4333-8444-555555555555", expected_public_head: HEAD, reviewed_head: "b".repeat(40),
  private_repo: { id: "5b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f", owner: "acme", name: "private-widgets" }, overlay_globs: ["docs/ops/"], pairing_digest: "d".repeat(64), read: { token: TOKEN, expires_at: "2026-10-25T12:00:00.000Z" }, ...over,
});
const verifyMessage = {
  order_id: ORDER, lease_generation: 1, reviewed_head: "b".repeat(40), public_head: HEAD, same: true, incomplete: false, paths: ["src/a.ts"], pairing_digest: "d".repeat(64), token_revoked: true,
};
function clientAnswering(status: number, body: unknown) {
  const seen: Array<{ url: string; body: string }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), body: String(init.body) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { client: createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => new Date(), fetchFn }), seen };
}

describe("the capability", () => {
  it("this build advertises plane_merge_v1 on hello", () => {
    expect(RUNNER_BUILD_CAPABILITIES).toContain("plane_merge_v1");
  });
});

describe("plane-merge-claim", () => {
  it("sends an empty strict message to the constant path and returns the order with its read credential", async () => {
    const { client, seen } = clientAnswering(200, claimedBody());
    const got = await client.planeMergeClaim();
    expect(got).toMatchObject({ kind: "order", order: { order_id: ORDER, lease_generation: 1, read: { token: TOKEN } } });
    expect(seen[0]!.url).toBe(`https://cloud.example.test${PLANE_MERGE_CLAIM_PATH}`);
    expect(PlaneMergeClaimMessage.parse(JSON.parse(seen[0]!.body))).toEqual({});
  });
  it("retry_after is 'none'; a field the protocol does not list, or a malformed sha, is an invalid reply; 409 is fenced", async () => {
    expect(await clientAnswering(200, { retry_after: 60 }).client.planeMergeClaim()).toEqual({ kind: "none", retryAfter: 60 });
    expect(await clientAnswering(200, claimedBody({ extra: 1 })).client.planeMergeClaim()).toMatchObject({ kind: "error", code: "invalid_reply" });
    expect(await clientAnswering(200, claimedBody({ expected_public_head: "nope" })).client.planeMergeClaim()).toMatchObject({ kind: "error", code: "invalid_reply" });
    expect(await clientAnswering(409, errorBody("fenced")).client.planeMergeClaim()).toEqual({ kind: "fenced" });
    expect(await clientAnswering(503, errorBody("not_configured")).client.planeMergeClaim()).toMatchObject({ kind: "error", status: 503, code: "not_configured" });
  });
});

describe("plane-merge-verify", () => {
  it("sends the strict message and maps go, no go and head moved", async () => {
    const go = clientAnswering(200, { go: true, token: TOKEN, expires_at: "2026-10-25T12:00:00.000Z", sha: HEAD });
    expect(await go.client.planeMergeVerify(verifyMessage)).toEqual({ kind: "go", token: TOKEN, expiresAt: "2026-10-25T12:00:00.000Z", sha: HEAD });
    // D#694 B7-1: the merge mode the cloud sent rides along; none sent is none carried.
    for (const mode of ["queue", "direct"] as const) {
      expect(await clientAnswering(200, { go: true, token: TOKEN, expires_at: "2026-10-25T12:00:00.000Z", sha: HEAD, merge_mode: mode }).client.planeMergeVerify(verifyMessage)).toEqual({ kind: "go", token: TOKEN, expiresAt: "2026-10-25T12:00:00.000Z", sha: HEAD, mergeMode: mode });
    }
    expect(await clientAnswering(200, { go: true, token: TOKEN, expires_at: "2026-10-25T12:00:00.000Z", sha: HEAD, merge_mode: "auto_merge" }).client.planeMergeVerify(verifyMessage)).toMatchObject({ kind: "error", code: "invalid_reply" });
    expect(go.seen[0]!.url).toBe(`https://cloud.example.test${PLANE_MERGE_VERIFY_PATH}`);
    expect(PlaneMergeVerifyMessage.parse(JSON.parse(go.seen[0]!.body))).toEqual(verifyMessage);
    expect(await clientAnswering(200, { go: false, reasons: ["public_head_not_reviewed"] }).client.planeMergeVerify(verifyMessage)).toEqual({ kind: "no_go", reasons: ["public_head_not_reviewed"] });
    expect(await clientAnswering(200, { go: false, head_moved: true }).client.planeMergeVerify(verifyMessage)).toEqual({ kind: "head_moved" });
  });
  it("409 is fenced with the cloud's word; a go with no token, or an extra key, is an invalid reply; an incomplete-and-same message is never sent", async () => {
    expect(await clientAnswering(409, errorBody("already_issued")).client.planeMergeVerify(verifyMessage)).toEqual({ kind: "fenced", code: "already_issued" });
    expect(await clientAnswering(200, { go: true, sha: HEAD }).client.planeMergeVerify(verifyMessage)).toMatchObject({ kind: "error", code: "invalid_reply" });
    expect(await clientAnswering(200, { go: false, reasons: ["x"], extra: 1 }).client.planeMergeVerify(verifyMessage)).toMatchObject({ kind: "error", code: "invalid_reply" });
    const refused = clientAnswering(200, { go: false, reasons: ["x"] });
    expect(await refused.client.planeMergeVerify({ ...verifyMessage, incomplete: true })).toMatchObject({ kind: "error", code: "invalid_message" });
    expect(refused.seen).toHaveLength(0);
  });
});

describe("plane-merge-report", () => {
  it("sends the strict message; recorded, retry (503 with retry_after) and fenced are told apart", async () => {
    const body = { order_id: ORDER, lease_generation: 1, result: "merged", http_status: 200, token_revoked: true } as const;
    const ok = clientAnswering(200, { recorded: true });
    expect(await ok.client.planeMergeReport(body)).toEqual({ kind: "recorded" });
    expect(ok.seen[0]!.url).toBe(`https://cloud.example.test${PLANE_MERGE_REPORT_PATH}`);
    expect(PlaneMergeReportMessage.parse(JSON.parse(ok.seen[0]!.body))).toEqual(body);
    expect(await clientAnswering(503, { retry_after: 30 }).client.planeMergeReport(body)).toEqual({ kind: "retry", retryAfter: 30 });
    expect(await clientAnswering(503, errorBody("not_configured")).client.planeMergeReport(body)).toMatchObject({ kind: "error", status: 503 });
    expect(await clientAnswering(409, errorBody("fenced")).client.planeMergeReport(body)).toEqual({ kind: "fenced", code: "fenced" });
    // An abort needs its code and only an abort carries one.
    const bad = clientAnswering(200, { recorded: true });
    expect(await bad.client.planeMergeReport({ ...body, result: "aborted" })).toMatchObject({ kind: "error", code: "invalid_message" });
    expect(bad.seen).toHaveLength(0);
  });
});

describe("the claim reply's merge_order flag", () => {
  it("rides an idle reply, and a claimed one, as mergeOrder true; absent otherwise", async () => {
    expect(await clientAnswering(200, { retry_after: 60, merge_order: true }).client.claim()).toEqual({ kind: "idle", retryAfter: 60, mergeOrder: true });
    expect(await clientAnswering(200, { retry_after: 60 }).client.claim()).toEqual({ kind: "idle", retryAfter: 60 });
    expect(await clientAnswering(200, { retry_after: 60, merge_order: false }).client.claim()).toMatchObject({ kind: "error", code: "invalid_reply" });
  });
});

describe("the poll loop's merge hook", () => {
  function rig(replies: ClaimResult[], onMergeOrder: () => Promise<"handled" | "none">) {
    const controller = new AbortController();
    let calls = 0;
    const clock = instantClock();
    const client = {
      async claim(): Promise<ClaimResult> {
        const next = replies[calls++];
        if (next === undefined) {
          controller.abort();
          return { kind: "idle", retryAfter: 1 };
        }
        return next;
      },
    };
    const run = () => pollLoop({ client, clock, gate: OPEN_GATE, signal: controller.signal, onClaimed: async () => undefined, onMergeOrder, random: () => 1 });
    return { run, clock, claims: () => calls };
  }

  it("an idle reply with the flag runs the hook and claims again at once when it took an order", async () => {
    let hooks = 0;
    const r = rig([{ kind: "idle", retryAfter: 60, mergeOrder: true }, { kind: "idle", retryAfter: 5 }], async () => (hooks++, "handled"));
    await r.run();
    expect(hooks).toBe(1);
    expect(r.clock.slept[0]).toBe(5_000);
  });
  it("when no order was there the loop waits as it would have (no spin)", async () => {
    let hooks = 0;
    const r = rig([{ kind: "idle", retryAfter: 60, mergeOrder: true }], async () => (hooks++, "none"));
    await r.run();
    expect(hooks).toBe(1);
    expect(r.clock.slept[0]).toBe(60_000);
  });
  it("an idle reply without the flag never runs the hook, and a hook that throws costs a pause, not the loop", async () => {
    let hooks = 0;
    const quiet = rig([{ kind: "idle", retryAfter: 60 }], async () => (hooks++, "handled"));
    await quiet.run();
    expect(hooks).toBe(0);
    const boom = rig([{ kind: "idle", retryAfter: 60, mergeOrder: true }], async () => Promise.reject(new Error("secret text")));
    expect(await boom.run()).toBe("stopped");
  });
});
