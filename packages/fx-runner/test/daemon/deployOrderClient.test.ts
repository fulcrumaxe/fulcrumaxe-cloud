import { describe, expect, it } from "vitest";
import { BROWSER_CHROME_CAPABILITY, DEPLOY_ORDER_CAPABILITY, DEPLOY_ORDER_CLAIM_PATH, DEPLOY_ORDER_REPORT_PATH, DeployOrderClaimMessage, DeployOrderReportMessage, type HelloMessage } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient, type ClaimResult } from "../../src/daemon/client.js";
import { pollLoop } from "../../src/daemon/pollLoop.js";
import { generateRunnerKey } from "../../src/keys.js";
import { RUNNER_BUILD_CAPABILITIES, RUNNER_PROTOCOL_VERSION, RUNNER_VERSION } from "../../src/version.js";
import { OPEN_GATE } from "../helpers/openGate.js";
import { instantClock } from "../helpers/manualClock.js";

/** D#749 V2b: the two signed calls of a deploy order, the claim flag, the poll loop's hook, and the hello that drops the two new capabilities first. */
const ORDER = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";
const SHA = "a".repeat(40);
const errorBody = (code: string): unknown => ({ error: { code, message: "x" } });
const claimedBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ order_id: ORDER, lease_generation: 1, lease_expires_at: "2026-11-09T12:00:00.000Z", repo: { owner: "acme", name: "widgets" }, sha: SHA, ...over });

function clientAnswering(status: number, body: unknown) {
  const seen: Array<{ url: string; body: string }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), body: String(init.body) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { client: createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => new Date(), fetchFn }), seen };
}

describe("deploy-order-claim", () => {
  it("sends an empty strict message to the constant path and returns the order: the repository and the commit, nothing to run", async () => {
    const { client, seen } = clientAnswering(200, claimedBody());
    const got = await client.deployOrderClaim();
    expect(got).toEqual({ kind: "order", order: { order_id: ORDER, lease_generation: 1, lease_expires_at: "2026-11-09T12:00:00.000Z", repo: { owner: "acme", name: "widgets" }, sha: SHA } });
    expect(seen[0]!.url).toBe(`https://cloud.example.test${DEPLOY_ORDER_CLAIM_PATH}`);
    expect(DeployOrderClaimMessage.parse(JSON.parse(seen[0]!.body))).toEqual({});
  });

  it("retry_after is none; a field the protocol does not list (a command, say), or a malformed commit, is an invalid reply; 409 is fenced", async () => {
    expect(await clientAnswering(200, { retry_after: 60 }).client.deployOrderClaim()).toEqual({ kind: "none", retryAfter: 60 });
    expect(await clientAnswering(200, claimedBody({ command: ["sh", "-c", "id"] })).client.deployOrderClaim()).toMatchObject({ kind: "error", code: "invalid_reply" });
    expect(await clientAnswering(200, claimedBody({ sha: "main" })).client.deployOrderClaim()).toMatchObject({ kind: "error", code: "invalid_reply" });
    expect(await clientAnswering(409, errorBody("fenced")).client.deployOrderClaim()).toEqual({ kind: "fenced" });
    expect(await clientAnswering(503, errorBody("not_configured")).client.deployOrderClaim()).toMatchObject({ kind: "error", status: 503, code: "not_configured" });
  });
});

describe("deploy-order-report", () => {
  const body: DeployOrderReportMessage = { order_id: ORDER, lease_generation: 1, result: "failed", failure_code: "exit_nonzero", exit_code: 3, output_tail: ["boom"] };

  it("sends the strict message; recorded and fenced are told apart", async () => {
    const ok = clientAnswering(200, { recorded: true });
    expect(await ok.client.deployOrderReport(body)).toEqual({ kind: "recorded" });
    expect(ok.seen[0]!.url).toBe(`https://cloud.example.test${DEPLOY_ORDER_REPORT_PATH}`);
    expect(DeployOrderReportMessage.parse(JSON.parse(ok.seen[0]!.body))).toEqual(body);
    expect(await clientAnswering(409, errorBody("fenced")).client.deployOrderReport(body)).toEqual({ kind: "fenced", code: "fenced" });
    expect(await clientAnswering(200, { recorded: false }).client.deployOrderReport(body)).toMatchObject({ kind: "error", code: "invalid_reply" });
  });

  it("a report the protocol would refuse is never sent: an exit status on a timeout, a success without status 0, a line with a control character, too many lines", async () => {
    const c = clientAnswering(200, { recorded: true });
    for (const bad of [{ ...body, failure_code: "timeout" }, { order_id: ORDER, lease_generation: 1, result: "succeeded" }, { ...body, output_tail: ["a\u0007b"] }, { ...body, output_tail: Array.from({ length: 21 }, () => "x") }]) {
      expect(await c.client.deployOrderReport(bad as never)).toMatchObject({ kind: "error", code: "invalid_message" });
    }
    expect(c.seen).toHaveLength(0);
  });
});

describe("the claim reply's deploy_order flag", () => {
  it("rides an idle reply as deployOrder true; absent otherwise; false is invalid", async () => {
    expect(await clientAnswering(200, { retry_after: 60, deploy_order: true }).client.claim()).toEqual({ kind: "idle", retryAfter: 60, deployOrder: true });
    expect(await clientAnswering(200, { retry_after: 60 }).client.claim()).toEqual({ kind: "idle", retryAfter: 60 });
    expect(await clientAnswering(200, { retry_after: 60, deploy_order: false }).client.claim()).toMatchObject({ kind: "error", code: "invalid_reply" });
  });
});

describe("the hello: the two new capabilities are the first to go", () => {
  const hello: HelloMessage = { protocol_version: RUNNER_PROTOCOL_VERSION, binary_version: RUNNER_VERSION, model_auth_present: false, isolation: "host_sandbox", capabilities: [...RUNNER_BUILD_CAPABILITIES, BROWSER_CHROME_CAPABILITY, DEPLOY_ORDER_CAPABILITY] };

  /** A cloud that predates the two capabilities: it answers 400 invalid_message to a hello that lists either, and 200 to one that does not. */
  function oldCloud() {
    const sent: string[][] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const caps = (JSON.parse(String(init.body)).capabilities ?? []) as string[];
      sent.push(caps);
      const unknown = caps.includes(BROWSER_CHROME_CAPABILITY) || caps.includes(DEPLOY_ORDER_CAPABILITY);
      return new Response(JSON.stringify(unknown ? errorBody("invalid_message") : {}), { status: unknown ? 400 : 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { client: createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => new Date(), fetchFn }), sent };
  }

  it("a cloud without them refuses, and the hello goes again with every other capability kept; the answer says which were dropped", async () => {
    const { client, sent } = oldCloud();
    const answer = await client.hello(hello);
    expect(answer).toMatchObject({ kind: "ok", dropped: [BROWSER_CHROME_CAPABILITY, DEPLOY_ORDER_CAPABILITY] });
    expect(sent).toHaveLength(3);
    expect(sent.at(-1)).toEqual([...RUNNER_BUILD_CAPABILITIES]);
  });

  it("a hello that lists neither is sent once and drops nothing", async () => {
    const { client, sent } = oldCloud();
    expect(await client.hello({ ...hello, capabilities: [...RUNNER_BUILD_CAPABILITIES] })).toEqual({ kind: "ok" });
    expect(sent).toHaveLength(1);
  });
});

describe("the poll loop's deploy hook", () => {
  function rig(replies: ClaimResult[], onDeployOrder: () => Promise<"handled" | "none">, onMergeOrder?: () => Promise<"handled" | "none">) {
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
    const run = () => pollLoop({ client, clock, gate: OPEN_GATE, signal: controller.signal, onClaimed: async () => undefined, onDeployOrder, ...(onMergeOrder === undefined ? {} : { onMergeOrder }), random: () => 1 });
    return { run, clock, claims: () => calls };
  }

  it("an idle reply with the flag runs the hook and claims again at once when it took an order", async () => {
    let hooks = 0;
    const r = rig([{ kind: "idle", retryAfter: 60, deployOrder: true }, { kind: "idle", retryAfter: 5 }], async () => (hooks++, "handled"));
    await r.run();
    expect(hooks).toBe(1);
    expect(r.clock.slept[0]).toBe(5_000);
  });

  it("an idle reply with the flag where no order was there waits the cloud's retry_after as it would", async () => {
    let hooks = 0;
    const r = rig([{ kind: "idle", retryAfter: 60, deployOrder: true }], async () => (hooks++, "none"));
    await r.run();
    expect(hooks).toBe(1);
    expect(r.clock.slept[0]).toBe(60_000);
  });

  it("no flag, no hook; a hook that throws is a pause, never text; a merge flag and a deploy flag are each their own hook", async () => {
    let deploy = 0;
    let merge = 0;
    await rig([{ kind: "idle", retryAfter: 60 }], async () => (deploy++, "handled")).run();
    expect(deploy).toBe(0);
    const boom = rig([{ kind: "idle", retryAfter: 60, deployOrder: true }], async () => Promise.reject(new Error("secret text")));
    await expect(boom.run()).resolves.toBe("stopped");
    const both = rig([{ kind: "idle", retryAfter: 60, deployOrder: true, mergeOrder: true }, { kind: "idle", retryAfter: 5 }], async () => (deploy++, "handled"), async () => (merge++, "none"));
    await both.run();
    expect([deploy, merge]).toEqual([1, 1]);
  });
});
