import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EnvironmentFailedError, startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import type { ExecutionTargetRegistry } from "../src/executionTarget.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * D#5 E9 [pg]: the environment step runs before the run exists. A ready environment is written to the run row at insert
 * (version and image digest, before the run starts); a failed one leaves no run, no run event, no reservation and no
 * sandbox. A paused account makes admit refuse, so these runs end at `refused_spend` without a sandbox.
 */
const VERSION = "a".repeat(64);
const DIGEST = `sha256:${"b".repeat(64)}`;

describe("environment on the run row [pg]", () => {
  const db = pgHarness();

  async function world() {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await db.admin.query(`UPDATE accounts SET owner_paused_at = now() WHERE id = $1`, [accountId]);
    return { accountId, repoId };
  }
  const input = (accountId: string, repoId: string, over: Partial<StartAgentRunInput>): StartAgentRunInput => ({
    accountId, repoId, role: "code-reviewer", product: "team", roleCard: "r", prompt: "p", model: "haiku-4.5", capUsd: 5,
    spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" }, ...over,
  });
  const count = async (table: string, accountId: string) =>
    Number((await db.admin.query(`SELECT count(*) AS n FROM ${table} WHERE account_id = $1`, [accountId])).rows[0].n);

  it("a ready environment is recorded on the run at insert, and the run is created after it was resolved", async () => {
    const { accountId, repoId } = await world();
    const order: string[] = [];
    const harness = createSandboxTargetHarness(db.runWriterPool);
    const registry: ExecutionTargetRegistry = { sandbox: new SandboxTarget(harness.deps) };
    const result = await startAgentRun(
      db.runWriterPool, registry,
      input(accountId, repoId, {
        ensureEnv: async () => {
          order.push(`resolved; runs so far: ${await count("agent_runs", accountId)}`);
          return { kind: "ready", envVersionId: VERSION, imageDigest: DIGEST };
        },
      }),
    );
    expect(order).toEqual(["resolved; runs so far: 0"]);
    const { rows } = await db.admin.query(`SELECT env_version_id, image_digest FROM agent_runs WHERE id = $1`, [result.id]);
    expect(rows[0]).toEqual({ env_version_id: VERSION, image_digest: DIGEST });
  });

  it("no environment (none, or no step at all) leaves both columns null and starts as before", async () => {
    const { accountId, repoId } = await world();
    const harness = createSandboxTargetHarness(db.runWriterPool);
    const registry: ExecutionTargetRegistry = { sandbox: new SandboxTarget(harness.deps) };
    const a = await startAgentRun(db.runWriterPool, registry, input(accountId, repoId, { ensureEnv: async () => ({ kind: "none" }) }));
    const b = await startAgentRun(db.runWriterPool, registry, input(accountId, repoId, {}));
    const { rows } = await db.admin.query(`SELECT env_version_id, image_digest FROM agent_runs WHERE id = ANY($1)`, [[a.id, b.id]]);
    expect(rows).toEqual([{ env_version_id: null, image_digest: null }, { env_version_id: null, image_digest: null }]);
  });

  it("a failed environment throws, and leaves no run row, no run event, no reservation and no sandbox", async () => {
    const { accountId, repoId } = await world();
    const harness = createSandboxTargetHarness(db.runWriterPool);
    const registry: ExecutionTargetRegistry = { sandbox: new SandboxTarget(harness.deps) };
    const err = await startAgentRun(
      db.runWriterPool, registry,
      input(accountId, repoId, { ensureEnv: async () => ({ kind: "error", file: ".fulcrumaxe/env.yaml", step: "parse_config", message: ".fulcrumaxe/env.yaml: parse_config: preset: unknown" }) }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentFailedError);
    expect(err).toMatchObject({ code: "environment_failed", file: ".fulcrumaxe/env.yaml", step: "parse_config" });
    expect((err as Error).message).toContain("parse_config");
    expect(await count("agent_runs", accountId)).toBe(0);
    expect(await count("run_events", accountId)).toBe(0);
    expect(await count("spend_reservations", accountId)).toBe(0);
    expect(harness.fakeSandbox.state.created).toHaveLength(0);
  });
});
