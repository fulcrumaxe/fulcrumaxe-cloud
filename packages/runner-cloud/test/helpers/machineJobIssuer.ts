import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { signMachineJob, type MachineJob, type MachineJobKind, type SignedMachineJob } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";

/**
 * D#845 ON-8a: a TEST-ONLY issuer. The real one is ON-8b's (`issueProjectSetup`); this signs a machine job with a test key and inserts it through the same definer (`machine_job_issue`), in a tenant
 * session and never a runner's, so what the claim path is tested against is exactly what the cloud's own issuer will write.
 */
let counter = 0;
const keys = generateKeyPairSync("ed25519");
export const JOB_KEY_ID = "job-key-test";
export const JOB_KEYRING = { [JOB_KEY_ID]: keys.publicKey };

const SHA = "a".repeat(40);
const HEX = "b".repeat(64);
const ENGINE = { version: "1.2.3", commit_sha: SHA, tarball_url: `https://codeload.github.com/acme/engine/tar.gz/${SHA}`, tarball_sha256: HEX };
const ARGS: Record<MachineJobKind, Record<string, unknown>> = {
  project_setup: { mode: "pr", base_sha: SHA, engine: ENGINE, plan_ref: { draft_id: randomUUID(), version: 1, sha256: HEX }, branch: "fx/engine-install-1.2.3" },
  engine_update: { engine: ENGINE, branch: "fx/engine-update-1.2.4" },
  engine_session_start: { at_sha: SHA, resume: false },
  engine_session_stop: { reason: "person" },
  engine_session_delete: {},
  project_remove: { delete_sandbox: true, removal_pr: false },
};

export interface IssueOptions {
  accountId: string;
  userId: string;
  runnerId: string;
  repoId: string;
  setupId?: string | null;
  kind?: MachineJobKind;
  requiresEngine?: "microvm" | "any";
  /** How long the signed job lives, in seconds (default 600); its signed life is this long from when it was issued. */
  lifeS?: number;
  /** How long ago it was issued, in seconds (default 5, so a clock a little behind the cloud's still takes it). */
  issuedAgoS?: number;
  /** Parameters the call to the definer disagrees with its own signed bytes on (a test of the binding): the setup, and the issue and expiry times moved by some milliseconds. */
  callAs?: { setupId?: string | null; issuedDeltaMs?: number; expiresDeltaMs?: number };
}

export async function issueTestJob(appPool: Pool, admin: PoolClient, o: IssueOptions): Promise<{ id: string; attempt: number; signed: SignedMachineJob }> {
  const kind = o.kind ?? "project_setup";
  const id = randomUUID();
  const ghRepoId = Number((await admin.query<{ gh_repo_id: string }>("SELECT gh_repo_id FROM repos WHERE id = $1", [o.repoId])).rows[0]!.gh_repo_id);
  const issued = new Date(Date.now() - (o.issuedAgoS ?? 5) * 1000 + counter++);
  const expires = new Date(issued.getTime() + (o.lifeS ?? 600) * 1000);
  const setupId = o.setupId === undefined ? null : o.setupId;
  const job = { v: 1, job_id: id, runner_id: o.runnerId, repo_gh_id: ghRepoId, ...(setupId ? { setup_id: setupId } : {}), requires_engine: o.requiresEngine ?? "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(), kind, args: ARGS[kind] } as MachineJob;
  const signed = signMachineJob(job, JOB_KEY_ID, keys.privateKey);
  const attempt = await withTenant(appPool, o.accountId, o.userId, async (client) => {
    const asked = { setup: o.callAs && "setupId" in o.callAs ? o.callAs.setupId : setupId, issued: new Date(issued.getTime() + (o.callAs?.issuedDeltaMs ?? 0)), expires: new Date(expires.getTime() + (o.callAs?.expiresDeltaMs ?? 0)) };
    const { rows } = await client.query<{ a: number }>("SELECT machine_job_issue($1, $2, $3, $4, $5, $6::jsonb, $7, $8) AS a", [id, o.runnerId, o.repoId, asked.setup, kind, JSON.stringify(signed), asked.issued, asked.expires]);
    return rows[0]!.a;
  });
  return { id, attempt, signed };
}
