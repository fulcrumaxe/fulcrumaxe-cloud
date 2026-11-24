import { randomUUID } from "node:crypto";
import { MACHINE_JOB_MAX_LIFE_S, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { emitSetupChanged } from "@fx/core/src/onboarding/engineTrack.js";
import type { RunnerCloudDeps } from "./http.js";
import { verifyRunnerRequest, withRunnerSession } from "./verifyRunnerRequest.js";

type Runner = Awaited<ReturnType<typeof verifyRunnerRequest>>;

/**
 * D#845 ON-8f: a direct-mode job lost the race for the default branch (someone pushed first and the runner reported `direct_raced`). The cloud issues the same setup again as a pull request job at the new head
 * (attempt + 1), without waiting for a person. The new job is the raced one's own signed arguments with `mode` = `pr` and `base_sha` = the head GitHub now shows; the definer (`machine_job_reissue`, 1071) refuses
 * anything else, so the runner's session can do nothing with this path but that. Best effort: GitHub unreachable, no signer, or a branch that still has no commit leave the setup failed `direct_raced`, and the person's
 * Retry (`retryInstall`) issues the next attempt the ordinary way. Returns whether a job was issued. Never throws.
 */
export async function reissueRacedSetup(deps: RunnerCloudDeps, runner: Runner, setupId: string, jobId: string): Promise<boolean> {
  try {
    const signer = (await deps.engineCommandSigner?.()) ?? null;
    const github = deps.pullRequests ?? null;
    if (signer?.signMachineJob === undefined || github === null) return false;
    const raced = await withRunnerSession(deps.appUserPool, runner, async (client) => {
      const job = (await client.query<{ job: (MachineJob & { kind: "project_setup" }) | null }>("SELECT machine_job_raced($1::uuid) AS job", [jobId])).rows[0]?.job ?? null;
      if (job === null || job.setup_id !== setupId) return null;
      const repo = (await client.query<{ id: string; gh_owner: string | null; gh_name: string | null }>("SELECT r.id, r.gh_owner, r.gh_name FROM machine_jobs j JOIN repos r ON r.account_id = j.account_id AND r.id = j.repo_id WHERE j.account_id = $1 AND j.id = $2", [runner.accountId, jobId])).rows[0];
      return repo?.gh_owner && repo.gh_name ? { job, repo: { id: repo.id, owner: repo.gh_owner, name: repo.gh_name } } : null;
    });
    if (raced === null) return false;
    const branch = await github.defaultBranch(raced.repo);
    const state = await github.branchState({ repo: raced.repo, branch, base: branch });
    if (!state.exists || state.headOid === null) return false;
    const issued = (deps.now ?? (() => new Date()))();
    const expires = new Date(issued.getTime() + MACHINE_JOB_MAX_LIFE_S * 1000);
    const newId = randomUUID();
    const signed = signer.signMachineJob({ ...raced.job, job_id: newId, issued_at: issued.toISOString(), expires_at: expires.toISOString(), args: { ...raced.job.args, mode: "pr", base_sha: state.headOid } } as MachineJob);
    return await withRunnerSession(deps.appUserPool, runner, async (client) => {
      await client.query("SELECT machine_job_reissue($1::uuid, $2::uuid, $3::jsonb, $4, $5)", [jobId, newId, JSON.stringify(signed), issued, expires]);
      await emitSetupChanged(client, { accountId: runner.accountId, setupId, repoId: raced.repo.id });
      return true;
    });
  } catch {
    // fx-swallow-ok: the setup stays failed `direct_raced` and a person's Retry issues the next attempt; nothing of an error from GitHub or the database is kept
    return false;
  }
}
