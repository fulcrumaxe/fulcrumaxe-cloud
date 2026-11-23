import { randomUUID } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { SURVEY_ROLE, sha256Text, signJob, type Job } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";

/**
 * D#845 ON-10a: a TEST-ONLY survey-run issuer. The real one is ON-10b's (`startSurvey`); this signs a survey job with a test key, inserts the pending run the way the run table holds any runner run, and binds it to the
 * setup through the same definer (`survey_start_record`, a person's session), so what the `done` branch is tested against is what the cloud's own starter will write.
 */
export interface SurveyRunOptions {
  accountId: string;
  userId: string;
  repoId: string;
  signing: KeyObject;
  /** The setup to bind; a new one in phase survey on `repoId` when absent. */
  setupId?: string;
  /** The base of the run's creation time, so a claim finds it the oldest. */
  createdMs: number;
  expiresMs: number;
  role?: string;
  taskKind?: Job["task"]["kind"];
}

export async function issueSurveyRun(admin: PoolClient, appPool: Pool, o: SurveyRunOptions): Promise<{ runId: string; setupId: string }> {
  const runId = randomUUID();
  const setupId = o.setupId ?? randomUUID();
  if (o.setupId === undefined) await admin.query(`INSERT INTO project_setups (id, account_id, repo_id, kind, phase, created_by) VALUES ($1, $2, $3, 'existing', 'survey', $4)`, [setupId, o.accountId, o.repoId, o.userId]);
  const prompt = "Survey the repository and answer with the project draft.";
  const card = "You are the project surveyor.";
  const job: Job = {
    schema_version: 1,
    job_id: randomUUID(),
    run_id: runId,
    repo: { id: o.repoId, owner: "acme", name: "widgets", private: true },
    role: (o.role ?? SURVEY_ROLE) as Job["role"],
    mode: "local",
    spec: null,
    task: { kind: o.taskKind ?? "survey", prompt, prompt_sha256: sha256Text(prompt) },
    role_card: { text: card, sha256: sha256Text(card) },
    role_tools_sha256: "a".repeat(64),
    continues: null,
    review: { head_sha: "c".repeat(40) },
    branch_prefix: "fx/",
    model_hint: null,
    issued_at: new Date(o.createdMs - 1000).toISOString(),
    expires_at: new Date(o.expiresMs).toISOString(),
    key_id: "k1",
  };
  await admin.query(
    `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, job_signed, initiated_by, created_at)
     VALUES ($1, $2, $3, 'runner', 'pending', 'runner_local', $4, $5::jsonb, $6, to_timestamp($7 / 1000.0))`,
    [runId, o.accountId, job.role, o.repoId, JSON.stringify(signJob(job, o.signing)), o.userId, o.createdMs],
  );
  await withTenant(appPool, o.accountId, o.userId, (c) => c.query("SELECT survey_start_record($1, $2)", [setupId, runId]));
  return { runId, setupId };
}
