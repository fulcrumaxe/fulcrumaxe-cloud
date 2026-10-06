import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { insertAgentRun, writeRunStatus, type ExecutionTargetRegistry } from "@fx/runner";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { realRunActionFacade } from "../../../worker/test/support/realFacade.js";
import { pgHarness } from "./pgHarness.js";

/**
 * Fixtures for the run-action [pg] tests: real Postgres, the REAL facade and definers
 * (built over the run-writer test login), and a fake sandbox target whose `cancel` is the
 * stop. The request rows are written by the real `run_action_request` definer, as the
 * session member or as an API token's creator.
 */
export const HASH = "h".repeat(64);

export function runActionsWorld(db: ReturnType<typeof pgHarness>) {
  /** A fake registry: `cancel` records the run id (the sandbox stop), settled 0.25 / released 0.75. */
  function fakeRegistry() {
    const stops: string[] = [];
    const unused = async () => {
      throw new Error("unused");
    };
    const target = {
      admit: unused,
      dispatch: unused,
      resume: unused,
      finalize: unused,
      cancel: async (run: { id: string }) => (stops.push(run.id), { settled_usd: 0.25, released_usd: 0.75 }),
    };
    return { registry: { sandbox: target } as unknown as ExecutionTargetRegistry, stops };
  }

  const fresh = (): Promise<SeedRefs> => seedAccount(db.admin, randomUUID());
  const facadeFor = (registry: ExecutionTargetRegistry) => realRunActionFacade(db.runWriterPool, registry);

  async function run(a: SeedRefs, status: "pending" | "running" | "succeeded" = "running", workItemId: string = a.workItemId): Promise<string> {
    const { id } = await insertAgentRun(db.runWriterPool, { id: randomUUID(), accountId: a.accountId, workItemId, role: "code-reviewer", runtime: "production", executionMode: "sandbox" });
    if (status !== "pending") await writeRunStatus(db.runWriterPool, { accountId: a.accountId, runId: id, from: "pending", to: "running" });
    if (status === "succeeded") await writeRunStatus(db.runWriterPool, { accountId: a.accountId, runId: id, from: "running", to: "succeeded" });
    return id;
  }

  async function item(a: SeedRefs): Promise<string> {
    const id = randomUUID();
    await db.admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'feature', 'internal', 'in_progress')", [id, a.accountId, a.repoId]);
    return id;
  }

  async function token(a: SeedRefs): Promise<string> {
    const sql =
      "INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at) VALUES ($1, $2, $3, 'fxat_x', ARRAY['runs:cancel'], now() + interval '1 day') RETURNING id";
    return (await db.admin.query(sql, [a.accountId, a.userId, randomUUID()])).rows[0].id;
  }

  /** The real request definer, as the session member (or as the token's creator when a token is given). */
  async function request(a: SeedRefs, kind: "cancel_run" | "cancel_work_item", target: string, tokenId?: string): Promise<string> {
    const row = await withTenant(db.pureAppUserPool as Pool, a.accountId, a.userId, tokenId, async (c) => (await c.query("SELECT * FROM run_action_request($1, $2, NULL, $3)", [kind, target, HASH])).rows[0]);
    return row.action_id;
  }

  const actionRow = async (id: string) => (await db.admin.query("SELECT * FROM run_action_requests WHERE id = $1", [id])).rows[0];
  const statusOf = async (runId: string) => (await db.admin.query("SELECT status FROM agent_runs WHERE id = $1", [runId])).rows[0]?.status as string;
  const events = async (type: string, subjectId: string) => (await db.admin.query("SELECT payload FROM domain_events WHERE type = $1 AND subject_id = $2", [type, subjectId])).rows;
  /** Makes an accepted row due now (skips a retry's backoff). */
  const makeDue = (id: string) => db.admin.query("UPDATE run_action_requests SET not_before = now() - interval '1 second' WHERE id = $1", [id]);

  return { fakeRegistry, fresh, facadeFor, run, item, token, request, actionRow, statusOf, events, makeDue };
}
