import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { operatorTokenFor } from "@fx/runtime/src/operatorSubscription.js";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget, type ModelConnectionPort, type SandboxTargetDeps } from "../src/targets/sandboxTarget.js";
import type { ExecutionRun } from "../src/executionTarget.js";
import type { StartDetachedOptions } from "../src/sandboxPort.js";
import { buildSandboxEnv } from "../src/sandboxEnv.js";
import type { NormalizedEvent } from "../src/types.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { createFakeModelConnectionPort, createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

const TOKEN = "sk-ant-oat01-FAKE-OPERATOR-TOKEN-FOR-TEST-ONLY";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`test setup: ${what} never happened within ${timeoutMs}ms`);
    await sleep(5);
  }
}

/**
 * The operator exception at the sandbox target: our own subscription for our own accounts, brokered at the firewall,
 * recorded at $0 under its own ledger source, still capped per run, and never reachable by anyone else. [pg], zero
 * model tokens. The decision function is the real `operatorTokenFor` over a real env object, so the allow-list, the
 * token and the kill switch are what is under test, not a stub.
 */
describe("operator subscription at the sandbox target [pg]", () => {
  const db = pgHarness();

  const envFor = (accountIds: string[], over: Record<string, string | undefined> = {}) => ({
    FX_OPERATOR_SUBSCRIPTION: "on",
    FX_OPERATOR_ACCOUNT_IDS: accountIds.join(","),
    FX_OPERATOR_CLAUDE_OAUTH_TOKEN: TOKEN,
    ...over,
  });

  async function seedTenant(): Promise<{ accountId: string; repoId: string }> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    return { accountId, repoId };
  }

  async function addConnection(accountId: string): Promise<void> {
    await db.admin.query(
      `INSERT INTO model_connections (account_id, provider, status, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint)
       VALUES ($1, 'ai_gateway', 'ok', '\\x01', '\\x02', '\\x03', 1, 'fp-test')`,
      [accountId],
    );
  }

  function previewInput(accountId: string, repoId: string, over: Partial<StartAgentRunInput["spend"]> = {}): StartAgentRunInput {
    return {
      accountId,
      repoId,
      role: "project-manager",
      product: "team",
      roleCard: "card",
      prompt: "prompt",
      model: "haiku-4.5",
      capUsd: 20,
      // A preview as the seat builds it for an operator account: no monthly budget set, a $20 per-run cap.
      spend: { plan: "starter", estimateComputeUsd: 0.5, trigger: "foreground", purpose: "preview", estimateModelUsd: 20, monthlyModelBudgetUsd: 0, perSpawnCapUsd: 20, ...over },
    };
  }

  function build(events: NormalizedEvent[], deps: Partial<SandboxTargetDeps>, getEnv: () => Record<string, string | undefined>) {
    const harness = createSandboxTargetHarness(db.runWriterPool, events);
    const started: StartDetachedOptions[] = [];
    const port = harness.deps.sandboxPort;
    const lookups: string[] = [];
    const modelConnection: ModelConnectionPort = {
      get: (accountId) => (lookups.push(accountId), createFakeModelConnectionPort().get(accountId)),
    };
    const target = new SandboxTarget({
      ...harness.deps,
      modelConnection,
      operatorToken: (accountId, payer) => operatorTokenFor(getEnv(), accountId, payer),
      sandboxPort: { ...port, startDetached: (h, o) => (started.push(o), port.startDetached(h, o)) },
      ...deps,
    });
    return { harness, target, started, lookups };
  }

  const run = (id: string, accountId: string, spend: StartAgentRunInput["spend"]): ExecutionRun => ({
    id,
    accountId,
    role: "project-manager",
    product: "team",
    roleCard: "card",
    prompt: "prompt",
    model: "haiku-4.5",
    capUsd: 20,
    spend,
  });

  async function startAndFinish(
    t: ReturnType<typeof build>,
    input: StartAgentRunInput,
  ): Promise<{ runId: string; report: Parameters<SandboxTarget["finalize"]>[1] | undefined; started: boolean; refused?: string }> {
    const result = await startAgentRun(db.runWriterPool, { sandbox: t.target }, input);
    if (result.status !== "running") return { runId: result.id, report: undefined, started: false, refused: result.status };
    await waitFor(() => t.harness.hooks.calls.some((c) => c.hookToken === result.hookToken), "the hook resuming");
    const report = t.harness.hooks.calls.find((c) => c.hookToken === result.hookToken)!.report;
    await t.target.finalize(run(result.id, input.accountId, input.spend), report);
    return { runId: result.id, report, started: true };
  }

  const result = (): NormalizedEvent => ({ runId: "x", role: "project-manager", seq: 1, type: "result", ts: new Date().toISOString(), text: "ok" });
  /** A little real usage (100k input tokens, about $0.10 at API rates) so the run has a metered figure to settle. */
  const usage = (): NormalizedEvent => ({ runId: "x", role: "project-manager", seq: 1, type: "assistant", ts: new Date().toISOString(), messageId: "m1", usage: { inputTokens: 100_000, outputTokens: 0 } });

  it("an operator preview runs with no model connection: the firewall carries the token, the sandbox only a placeholder", async () => {
    const { accountId, repoId } = await seedTenant();
    const env = envFor([accountId]);
    const t = build([usage(), result()], {}, () => env);

    const out = await startAndFinish(t, previewInput(accountId, repoId));
    expect(out.started).toBe(true);
    expect(out.report?.status).toBe("succeeded");
    expect(out.report?.usd).toBeGreaterThan(0);

    // No tenant connection was read; the policy's model rule is api.anthropic.com with the bearer value.
    expect(t.lookups).toEqual([]);
    const opts = t.started[0]!;
    const model = opts.networkPolicy.find((r) => r.purpose === "model")!;
    expect([model.host, model.authHeader, model.authValue]).toEqual(["api.anthropic.com", "Authorization", `Bearer ${TOKEN}`]);
    expect(opts.env).toEqual(buildSandboxEnv("project-manager", "operator_subscription"));
    expect(JSON.stringify(opts.env)).not.toContain("FAKE-OPERATOR");
    expect(JSON.stringify(opts.networkPolicy)).not.toContain("FAKE-OPERATOR");

    // The ledger records the mode at $0; no model money was ever reserved or held.
    const ledger = await db.admin.query(`SELECT source, usd::float AS usd FROM ledger WHERE account_id = $1 AND run_id = $2 AND budget = 'model'`, [accountId, out.runId]);
    expect(ledger.rows).toEqual([{ source: "operator_subscription", usd: 0 }]);
    const open = await db.admin.query(`SELECT 1 FROM spend_reservations WHERE account_id = $1 AND run_id = $2 AND budget = 'model' AND state = 'open'`, [accountId, out.runId]);
    expect(open.rows).toEqual([]);

    // The metering event says which mode ran.
    const metering = await db.admin.query(`SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.metering'`, [out.runId]);
    expect(metering.rows[0].payload.flags).toContain("operator_subscription");
  });

  it("a customer account gets today's rules: no connection means a refused preview, and with one the tenant's own key rides the policy", async () => {
    const operator = randomUUID();
    const { accountId, repoId } = await seedTenant();
    const env = envFor([operator]); // switch on, token set, but this account is not listed
    const noConnection = build([result()], {}, () => env);
    // Money is not what refuses it: a budget and a small estimate are in place, so only the missing connection can.
    const funded = { estimateModelUsd: 1, monthlyModelBudgetUsd: 100 };
    const refused = await startAndFinish(noConnection, previewInput(accountId, repoId, funded));
    expect(refused.started).toBe(false);
    expect(noConnection.started).toHaveLength(0);
    // A spend fact that merely CLAIMS the broker changes nothing: only the operator decision can set it.
    const claimed = await startAndFinish(build([result()], {}, () => env), previewInput(accountId, repoId, { ...funded, modelBrokeredBy: "operator_subscription" }));
    expect(claimed.started).toBe(false);

    await addConnection(accountId);
    const withConnection = build([usage(), result()], {}, () => env);
    const out = await startAndFinish(withConnection, previewInput(accountId, repoId, { estimateModelUsd: 1, monthlyModelBudgetUsd: 100 }));
    expect(out.started).toBe(true);
    expect(withConnection.lookups).toEqual([accountId]);
    const model = withConnection.started[0]!.networkPolicy.find((r) => r.purpose === "model")!;
    expect([model.host, model.authValue]).toEqual(["ai-gateway.vercel.sh", "Bearer fake-plaintext-key-never-real"]);
    expect(JSON.stringify(withConnection.started[0])).not.toContain("FAKE-OPERATOR");
    const ledger = await db.admin.query(`SELECT source FROM ledger WHERE account_id = $1 AND run_id = $2 AND budget = 'model'`, [accountId, out.runId]);
    expect(ledger.rows.every((r) => r.source === "customer_gateway")).toBe(true);
  });

  it("a customer cannot borrow the mode through the payer: both the run's account and its payer must be operators", async () => {
    const operator = await seedTenant();
    const customer = await seedTenant();
    const env = envFor([operator.accountId]);
    const spend = previewInput(customer.accountId, customer.repoId).spend;
    // buildRunMaterials is where the policy is built; the payer is passed in as `payerFor(run)` computes it.
    const materials = async (runAccount: string, payer: string) => {
      const t = build([], {}, () => env);
      const out = await t.target["buildRunMaterials"](run(randomUUID(), runAccount, spend), payer);
      return { out, lookups: t.lookups };
    };
    for (const [runAccount, payer] of [[customer.accountId, operator.accountId], [operator.accountId, customer.accountId], [customer.accountId, customer.accountId]] as const) {
      const { out, lookups } = await materials(runAccount, payer);
      const model = out.networkPolicyRules.find((r) => r.purpose === "model")!;
      expect([model.host, model.authValue], `${runAccount === customer.accountId ? "customer" : "operator"} run paid by ${payer === customer.accountId ? "customer" : "operator"}`).toEqual(["ai-gateway.vercel.sh", "Bearer fake-plaintext-key-never-real"]);
      expect(out.env).toEqual(buildSandboxEnv("project-manager"));
      expect(lookups).toEqual([payer]);
    }
    const { out, lookups } = await materials(operator.accountId, operator.accountId);
    expect(out.networkPolicyRules.find((r) => r.purpose === "model")!.host).toBe("api.anthropic.com");
    expect(lookups).toEqual([]);
  });

  it("the kill switch is live: switched off, the same account follows the ordinary rules on its next run", async () => {
    const { accountId, repoId } = await seedTenant();
    let env = envFor([accountId]);
    const t = build([result()], {}, () => env);
    expect((await startAndFinish(t, previewInput(accountId, repoId))).started).toBe(true);
    env = envFor([accountId], { FX_OPERATOR_SUBSCRIPTION: undefined });
    const second = await startAndFinish(t, previewInput(accountId, repoId));
    expect(second.started).toBe(false); // no model connection, no operator mode
    expect(t.started).toHaveLength(1);
  });

  it("a runaway on the subscription is still stopped by the per-run cap, and it consumes none of the account's money", async () => {
    const { accountId, repoId } = await seedTenant();
    const env = envFor([accountId]);
    const big: NormalizedEvent = { runId: "x", role: "project-manager", seq: 1, type: "assistant", ts: new Date().toISOString(), usage: { inputTokens: 30_000_000, outputTokens: 0 } };
    const t = build([big], {}, () => env);
    const out = await startAndFinish(t, previewInput(accountId, repoId, { perSpawnCapUsd: 0.01 }));
    expect(out.report?.status).toBe("killed_spend");
    const ledger = await db.admin.query(`SELECT source, usd::float AS usd FROM ledger WHERE account_id = $1 AND run_id = $2 AND budget = 'model'`, [accountId, out.runId]);
    expect(ledger.rows).toEqual([{ source: "operator_subscription", usd: 0 }]);
  });

  it("a rejected operator token fails the run clearly and marks nothing broken on any account", async () => {
    const { accountId, repoId } = await seedTenant();
    const env = envFor([accountId]);
    const rejected: NormalizedEvent = { runId: "x", role: "project-manager", seq: 1, type: "error", ts: new Date().toISOString(), isError: true, text: "model returned 401 unauthorized" };
    const t = build([rejected], {}, () => env);
    const out = await startAndFinish(t, previewInput(accountId, repoId));
    expect(out.report?.failureReason).toBe("model_key_broken");
    expect(t.harness.connectionStatus.calls).toEqual([]);
    const row = await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [out.runId]);
    expect(row.rows[0].status).toBe("failed");
    const account = await db.admin.query(`SELECT key_broken_at FROM accounts WHERE id = $1`, [accountId]);
    expect(account.rows[0].key_broken_at).toBeNull();
    const metering = await db.admin.query(`SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.metering'`, [out.runId]);
    expect(metering.rows[0].payload.flags).toEqual(expect.arrayContaining(["operator_subscription", "operator_token_rejected"]));
  });

  it("a customer's own 401 still marks their key broken (the tenant path is untouched)", async () => {
    const { accountId, repoId } = await seedTenant();
    await addConnection(accountId);
    const rejected: NormalizedEvent = { runId: "x", role: "project-manager", seq: 1, type: "error", ts: new Date().toISOString(), isError: true, text: "model returned 401 unauthorized" };
    const t = build([rejected], {}, () => envFor([]));
    const out = await startAndFinish(t, previewInput(accountId, repoId, { estimateModelUsd: 1, monthlyModelBudgetUsd: 100 }));
    expect(t.harness.connectionStatus.calls).toEqual([{ runId: out.runId, code: 401 }]);
  });
});
