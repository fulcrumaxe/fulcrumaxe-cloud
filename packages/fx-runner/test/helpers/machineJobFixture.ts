import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { canonicalJson, signMachineJob, type JobKeyring, type MachineJob, type PlanFile, type SignedMachineJob } from "@fulcrumaxe/runner-protocol";

export const JOB_KEY_ID = "job-key-1";
const pair = generateKeyPairSync("ed25519");
/** The keyring a runner pins in these tests: the one key `signedJob` signs with. */
export const JOB_KEYRING: JobKeyring = { [JOB_KEY_ID]: pair.publicKey };
export const OTHER_JOB_KEYRING: JobKeyring = { [JOB_KEY_ID]: generateKeyPairSync("ed25519").publicKey };
export const RUNNER_ID = "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10";
export const SETUP_ID = "7a1d2c3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d";
export const DRAFT_ID = "5d0c6f0e-2a54-4f3b-8d1e-7a9c2b3d4e5f";
const SHA = "a".repeat(40);

export const samplePlan = (over: Partial<PlanFile> = {}): PlanFile => ({
  v: 1,
  draft_id: DRAFT_ID,
  version: 2,
  prd_md: "# Widgets\n\nA small service that **counts** widgets, `fast`.\n\n## Goals\n\nCount them.\n",
  roadmap: [
    { row_key: "A1", title: "Count widgets", summary: "Count every widget once.", size: "M", depends_on: [] },
    { row_key: "B-2", title: "Report counts", summary: "", size: "S", depends_on: ["A1"] },
  ],
  setup: { kind: "existing", repo_owner: "acme", repo_name: "Widgets.Service", default_branch: "main", visibility: "private", boss_github_username: "jane-doe" },
  ...over,
});
/** The plan's exact bytes as the cloud serves them, and their sha256. */
export const planBytes = (plan: PlanFile): { text: string; sha256: string } => {
  const text = canonicalJson(plan);
  return { text, sha256: createHash("sha256").update(text).digest("hex") };
};

export function jobOf(over: Record<string, unknown> = {}, args: Record<string, unknown> = {}): MachineJob {
  const issued = Date.now() - 1000;
  const sum = planBytes(samplePlan());
  return {
    v: 1,
    job_id: randomUUID(),
    runner_id: RUNNER_ID,
    repo_gh_id: 77,
    setup_id: SETUP_ID,
    requires_engine: "any",
    issued_at: new Date(issued).toISOString(),
    expires_at: new Date(issued + 10 * 60_000).toISOString(),
    kind: "project_setup",
    args: {
      mode: "pr",
      base_sha: SHA,
      engine: { version: "1.2.3", commit_sha: SHA, tarball_url: `https://codeload.github.com/acme/engine/tar.gz/${SHA}`, tarball_sha256: "b".repeat(64) },
      plan_ref: { draft_id: DRAFT_ID, version: 2, sha256: sum.sha256 },
      branch: "fx/engine-install-1.2.3",
      ...args,
    },
    ...over,
  } as MachineJob;
}
export const signedJob = (job: MachineJob = jobOf()): SignedMachineJob => signMachineJob(job, JOB_KEY_ID, pair.privateKey);
