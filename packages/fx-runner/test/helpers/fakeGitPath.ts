import type { GitPath } from "../../src/daemon/gitPath.js";

/**
 * A git path that touches nothing by default: the workspace stays empty, nothing is pushed. Every call is recorded (before the
 * override, if one is given, runs), so a test can check the order of the three steps.
 */
export function fakeGitPath(over: Partial<GitPath> = {}): GitPath & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    check(job, lease) {
      calls.push(`check ${lease.runId} g${lease.leaseGeneration} ${job.branch_prefix}`);
      over.check?.(job, lease);
    },
    async resume(job, lease, workspace) {
      calls.push(`resume ${lease.runId}`);
      return over.resume ? over.resume(job, lease, workspace) : null;
    },
    async prepare(job, lease, workspace) {
      calls.push(`prepare ${lease.runId}`);
      return over.prepare ? over.prepare(job, lease, workspace) : { base: "0".repeat(40) };
    },
    readGrants(job) {
      return over.readGrants ? over.readGrants(job) : [];
    },
    async publish(job, lease, workspace, base, stopped) {
      calls.push(`publish ${lease.runId}`);
      return over.publish ? over.publish(job, lease, workspace, base, stopped) : { pushed: false };
    },
  };
}
