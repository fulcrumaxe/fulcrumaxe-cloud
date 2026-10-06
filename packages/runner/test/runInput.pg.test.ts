import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { listRunEvents } from "@fx/core/src/events/read.js";
import type { ExecutionTarget, ExecutionTargetRegistry } from "../src/executionTarget.js";
import { RUN_INPUT_PROMPT_CAP_BYTES, insertAgentRun } from "../src/runStatusWriter.js";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount, seedMember, seedRepo } from "./helpers/seed.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** D#31 API-6b-2 (R-PERSIST, K4): the start prompt is kept as one platform-only `run.input` event. [pg] */
describe("run.input [pg]", { timeout: 60_000 }, () => {
  const db = pgHarness();

  async function world() {
    const accountId = randomUUID();
    const userId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, userId);
    await seedRepo(db.admin, accountId, repoId);
    return { accountId, userId, repoId };
  }
  const inputOf = async (runId: string) =>
    (await db.admin.query("SELECT seq::int AS seq, payload FROM run_events WHERE run_id = $1 AND kind = 'run.input'", [runId])).rows as { seq: number; payload: Record<string, unknown> }[];

  it("startAgentRun records the prompt and its hash in the create transaction, right after run.created", async () => {
    const w = await world();
    const target = { runtime: "production", admit: async () => ({ admitted: false, reason: "stub" }) } as unknown as ExecutionTarget;
    const input = { accountId: w.accountId, repoId: w.repoId, role: "executor", product: "team", roleCard: "c", prompt: "do the thing", model: "haiku-4.5", capUsd: 1, spend: { plan: "starter" } } as StartAgentRunInput;
    const { id } = await startAgentRun(db.runWriterPool, { sandbox: target } as ExecutionTargetRegistry, input);
    expect(await inputOf(id)).toEqual([{ seq: 2, payload: { prompt: "do the thing", prompt_sha256: sha("do the thing") } }]);
  });

  it("startMeta rides in the run.input payload, and a denied admit records its reason on the refused_spend event", async () => {
    const w = await world();
    const target = { runtime: "production", admit: async () => ({ admitted: false, reason: "model_budget_exceeded" }) } as unknown as ExecutionTarget;
    const input = { accountId: w.accountId, repoId: w.repoId, role: "executor", product: "team", roleCard: "c", prompt: "p", model: "m", capUsd: 1, spend: { plan: "starter" }, startMeta: { model: "sonnet-5", escalated_from_model: null } } as StartAgentRunInput;
    const { id } = await startAgentRun(db.runWriterPool, { sandbox: target } as ExecutionTargetRegistry, input);
    expect((await inputOf(id))[0]!.payload.meta).toEqual({ model: "sonnet-5", escalated_from_model: null });
    const { rows } = await db.admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed'", [id]);
    expect(rows[0].payload).toEqual({ from: "pending", to: "refused_spend", failureReason: "model_budget_exceeded" });
  });

  it("a prompt over 48 KiB keeps only its hash; exactly 48 KiB is kept; no startPrompt writes no row", async () => {
    const w = await world();
    const make = async (startPrompt?: string) => (await insertAgentRun(db.runWriterPool, { id: randomUUID(), accountId: w.accountId, role: "executor", runtime: "production", startPrompt })).id;
    const over = "p".repeat(RUN_INPUT_PROMPT_CAP_BYTES + 1);
    expect((await inputOf(await make(over)))[0]!.payload).toEqual({ prompt_sha256: sha(over) });
    const exact = "p".repeat(RUN_INPUT_PROMPT_CAP_BYTES);
    expect((await inputOf(await make(exact)))[0]!.payload).toEqual({ prompt: exact, prompt_sha256: sha(exact) });
    expect(await inputOf(await make())).toEqual([]);
  });

  it("is redacted at source like every event (the stored prompt has no token shape), and the hash is of the prompt as given", async () => {
    const w = await world();
    const prompt = "use ghs_" + "a".repeat(30) + " to push";
    const { id } = await insertAgentRun(db.runWriterPool, { id: randomUUID(), accountId: w.accountId, role: "executor", runtime: "production", startPrompt: prompt });
    expect((await inputOf(id))[0]!.payload).toEqual({ prompt: "use [redacted] to push", prompt_sha256: sha(prompt) });
  });

  it("the customer events read returns run.created and no run.input, on the plain and the byte-bounded page", async () => {
    const w = await world();
    const { id } = await insertAgentRun(db.runWriterPool, { id: randomUUID(), accountId: w.accountId, role: "executor", runtime: "production", startPrompt: "secret instructions" });
    const ctx = { pool: db.pureAppUserPool, principal: { accountId: w.accountId, userId: w.userId } };
    for (const byteBounds of [undefined, { payloadCapBytes: 4096, pageBudgetBytes: 65536 }]) {
      const page = await listRunEvents(ctx, id, { limit: 50, byteBounds });
      expect(page.data.map((e) => e.kind)).toEqual(["run.created"]);
      expect(JSON.stringify(page)).not.toContain("secret instructions");
    }
  });
});
