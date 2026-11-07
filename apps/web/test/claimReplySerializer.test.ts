import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { claimReplyBytes, worstCaseClaimReplyBytes } from "@fulcrumaxe/runner-protocol";
import type { RunnerCloudDeps } from "@fx/runner-cloud";
import { handleRunnerRequest } from "../lib/runnerRoutes";

/**
 * The cloud measures a claim reply before it signs a job into the queue (`job_too_large`), and the route then sends it. Both must mean the same bytes: the figure
 * the issuer holds against the hosted budget is the length of what `NextResponse.json` writes, down to the characters JSON escapes and the ones that take several bytes.
 */
describe("claim reply measure matches the bytes the route sends", () => {
  const request = () => new NextRequest("https://runner.example.test/api/runner/claim", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const send = async (body: unknown): Promise<number> => {
    const res = await handleRunnerRequest(request(), async () => ({ status: 200, body }), () => ({}) as RunnerCloudDeps);
    expect(res.status).toBe(200);
    return (await res.arrayBuffer()).byteLength;
  };

  it("is the same length for text with control characters, quotes, multi-byte characters and a lone surrogate", async () => {
    const text = `a"b\\c\u0001\u0007${String.fromCharCode(0xd800)}é漢😀\n`;
    const reply = { signed_job: { job: { spec: { text } }, signature: "sig" }, run_id: "7b9d1c6e-4f0a-4c53-9a58-2f0d5b6c3a11", lease_generation: 12 };
    expect(await send(reply)).toBe(claimReplyBytes(reply));
  });

  it("the worst-case figure for a job is at least what the route sends with the fields the job does not fix at ordinary sizes", async () => {
    const signed = { job: { spec: { text: "x".repeat(1000) } }, signature: "s" };
    const runId = "7b9d1c6e-4f0a-4c53-9a58-2f0d5b6c3a11";
    const sent = await send({ signed_job: signed, run_id: runId, lease_generation: 4, wake: { token: `${"a".repeat(100)}.${"b".repeat(43)}`, poll_s: 30, transport: "poll" }, merge_order: true });
    expect(worstCaseClaimReplyBytes(signed, runId)).toBeGreaterThanOrEqual(sent);
  });
});
