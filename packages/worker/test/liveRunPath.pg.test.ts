import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLAUDE_CLI_VERSION, createTestConnectionStatusPort, followStatusBody, type HookResult, type SdkCommand, type SdkSandbox, type VercelSandboxSdk } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount } from "@fx/db/test/helpers/seed.js";
import { getPreview, requestPreview } from "../../core/src/onboarding/index.js";
import { createRecordingRunActionSignal } from "../../core/src/runActions/index.js";
import { buildPreviewPrompt } from "../../pipeline/src/preview/prompt.js";
import { parsePreviewResult } from "../../pipeline/src/preview/result.js";
import { performerFor, type RunActionsWorker } from "../../pipeline/src/runActions/dispatcher.js";
import { createFakeModelConnectionPort } from "../../runner/test/helpers/sandboxTargetFakes.js";
import { buildWorker } from "../src/compositionRoot.js";
import type { FollowArgs } from "../src/starter.js";
import { seedPreviewTarget } from "./support/previewTarget.js";

/**
 * D#2 H14c-3-3a-3, criterion 11 [pg]: the live run path over its fakes, built by the PRODUCTION composition. A preview
 * is requested and claimed; the worker starts it through the production starter and seat; the Vercel SDK fake plays
 * the sandbox (it prints the agent's final message with its envelope); the target finalizes the run and only then
 * wakes the hook with { runId, status }; the follower's status read sees the run over; and the preview's result is
 * readable the way GET /api/v1/onboarding/preview reads it. The hooks port here only records (the production port,
 * which forwards the same two fields to the Workflow service, is covered in apps/web/lib/hooks.test.ts; the first
 * real createHook/resumeHook is the live smoke).
 */
const ENVELOPE = {
  issues: [{ number: 7, title: "Crash on empty input", category: "bug", expected_model_usd: 2.5 }],
  sample_spec: { issue_number: 7, body: "## Spec\nFix the crash." },
};
const FINAL_MESSAGE = `Triage done.\n<!-- AGENT_OUTPUT -->\n\`\`\`json\n${JSON.stringify(ENVELOPE)}\n\`\`\`\n<!-- /AGENT_OUTPUT -->`;
const RESULT_LINE = `${JSON.stringify({ type: "result", is_error: false, result: FINAL_MESSAGE, session_id: "cc-session-1", total_cost_usd: 0.4, usage: { input_tokens: 1000, output_tokens: 200 } })}\n`;

/** The Vercel SDK as a fake sandbox that runs the agent to a successful result at once. */
function sdkFake(): VercelSandboxSdk {
  const sandbox = (name: string): SdkSandbox => ({
    name,
    status: "running",
    currentSession: () => ({ sessionId: "sess-1" }),
    async runCommand(params): Promise<SdkCommand> {
      const out = params.args?.[2] === "fx-pin" ? `${CLAUDE_CLI_VERSION}\n` : params.cmd === "sh" && params.args?.[0] === "-c" && String(params.args?.[1]).includes("proc") ? "12.5 3000 4096\n" : params.args?.includes("fx-agent") ? RESULT_LINE : "";
      return {
        async *logs() {
          if (out) yield { stream: "stdout", data: out };
        },
        wait: async () => ({ exitCode: 0 }),
        kill: async () => undefined,
      };
    },
    writeFiles: async () => undefined,
    updateNetworkPolicy: async () => undefined,
    extendTimeout: async () => undefined,
    stop: async () => undefined,
    delete: async () => undefined,
    listSessions: async () => ({
      sessions: [{ id: "sess-1", memory: 4096, region: "iad1", duration: 120_000, activeCpuDurationMs: 30_000, networkTransfer: { ingress: 5, egress: 100 } }],
      pagination: { next: null },
    }),
  });
  return { create: async (p) => sandbox(p.name), get: async (p) => sandbox(p.name) };
}

describe("the live run path over its fakes [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });

  it("request -> claim -> start -> sandbox ends -> finalized, then the hook { runId, status } -> status read -> the preview result is readable", async () => {
    const hooks: { token: string; result: HookResult; statusThen: string }[] = [];
    const follows: FollowArgs[] = [];
    const worker = await buildWorker({
      env: { FX_GH_FORWARD_SUFFIX: "fixture.test", FX_GH_FORWARD_HOST: "gh-proxy.fixture.test" },
      vercel: { teamId: "team_1", projectId: "prj_1", getToken: async () => "tok" },
      ports: {
        decryptTenantKey: async () => "fake-key",
        modelConnection: createFakeModelConnectionPort(),
        connectionStatus: createTestConnectionStatusPort(),
        hooks: {
          resume: async (token, result) => {
            hooks.push({ token, result, statusThen: (await admin.query("SELECT status FROM agent_runs WHERE id = $1", [result.runId])).rows[0].status as string });
          },
        },
        follow: async (args) => void follows.push(args),
      },
      previewPrompt: buildPreviewPrompt,
      sdk: sdkFake(),
      lookup: async () => [{ address: "140.82.112.3", family: 4 }],
      createPools: async () => ({ runnerPool: writerPool, platformOpsPool: adminPool, close: async () => undefined }),
    });
    expect(worker.previewReady()).toBe(true);
    // The production composition runs in the production order: it never turns finalize-before-resume off.
    expect(worker.targetDeps.finalizeBeforeResume ?? true).toBe(true);

    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE model_connections SET status = 'ok' WHERE account_id = $1", [a.accountId]);
    await admin.query("UPDATE accounts SET model_budget_usd_month = 500 WHERE id = $1", [a.accountId]);
    const t = await seedPreviewTarget(admin, a);
    const ctx = { pool: appPool, principal: { accountId: a.accountId, userId: a.userId } };
    const requested = await requestPreview(ctx, { repoId: t.repoId, confirmModelCapUsd: 20 }, { signal: createRecordingRunActionSignal(), available: () => true });
    const claimed = await worker.claimRunAction(requested.actionId, 600);
    expect(claimed?.kind).toBe("start_preview");

    const out = await performerFor("start_preview")!(worker as unknown as RunActionsWorker, requested.actionId);
    if (out.result !== "done") throw new Error(`expected done, got ${out.errorCode}`);
    const runId = out.outcome.run_id as string;

    // The producer (the target, in this process) finalizes the run, then wakes the hook with the two fixed fields.
    for (let i = 0; i < 200 && hooks.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.result).toEqual({ runId, status: "succeeded" });
    expect(hooks[0]!.statusThen).toBe("succeeded"); // finalized BEFORE the wake-up
    expect(hooks[0]!.token).toBe(follows[0]!.hookToken);

    // The follower: given by the starter, run-sized watchdog, and the status read says the run is over.
    expect(follows).toHaveLength(1);
    expect(follows[0]).toMatchObject({ runId, accountId: a.accountId });
    // Derived from the seat's own timeout plus a margin, not the 2 h default.
    expect(follows[0]!.watchdogMs).toBeGreaterThan(0);
    expect(follows[0]!.watchdogMs).not.toBe(2 * 60 * 60_000);
    expect(await followStatusBody(a.accountId, runId)).toEqual({ status: "succeeded", done: true });

    // GET /api/v1/onboarding/preview reads this: the projected result, the finished state.
    const preview = await getPreview(ctx, requested.previewId, { projectResult: parsePreviewResult });
    expect(preview).toMatchObject({ state: "finished", run_status: "succeeded", void_reason: null });
    expect(preview.result).toEqual(ENVELOPE);

    // The compute row is present and the model reservation is settled; nothing is left open.
    const compute = await admin.query("SELECT compute_basis FROM ledger WHERE run_id = $1 AND kind = 'compute'", [runId]);
    expect(compute.rows.length).toBe(1);
    expect(compute.rows[0].compute_basis).toBe("measured");
    const reservations = await admin.query("SELECT budget, state FROM spend_reservations WHERE run_id = $1 ORDER BY budget", [runId]);
    expect(reservations.rows.find((r) => r.budget === "model")?.state).toBe("settled");
    expect(reservations.rows.every((r) => r.state !== "open")).toBe(true);

    // The envelope stayed in agent_runs: it is in no event, and not in the hook's payload.
    expect(JSON.stringify((await admin.query("SELECT payload FROM run_events WHERE run_id = $1", [runId])).rows)).not.toContain("Crash on empty input");
    expect(JSON.stringify(hooks)).not.toContain("Crash on empty input");

    // A replay of the performer starts nothing and follows nothing more.
    expect(await performerFor("start_preview")!(worker as unknown as RunActionsWorker, requested.actionId)).toEqual(out);
    expect(follows).toHaveLength(1);
    await worker.close();
  });
});
