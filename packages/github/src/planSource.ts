import { createPlanReadClient, type PlanReadDeps, type PlanReadTarget } from "./planReadClient.js";
import { listIssuesAndPulls, readRepoFile, readRepoHead } from "./planReaders.js";

/**
 * D#483 S3: the read side of one plan import, shaped as @fx/core's `PlanSource` (structurally; this package does not import
 * core's plan module). It is built on the read-only client (planReadClient.ts), so it can ask GitHub for nothing but reads.
 * `evidence()` is the client's own request log and the permissions GitHub reported for the minted token.
 */
export interface PlanSourceFacts {
  number: number;
  title: string;
  state: "open" | "merged" | "closed";
  dLines: readonly string[];
}

export interface PlanSourceShape {
  head(): Promise<{ defaultBranch: string; sha: string }>;
  file(path: string, ref: string, maxBytes: number): Promise<string | null>;
  pulls(): Promise<{ pulls: PlanSourceFacts[]; truncated: boolean }>;
  evidence(): { requests: Array<{ method: string; path: string; status: number }>; tokenPermissions: Record<string, string> | null };
}

export function createPlanSourceFactory(deps: PlanReadDeps): (target: PlanReadTarget) => PlanSourceShape {
  const open = createPlanReadClient(deps);
  return (target) => {
    const client = open(target);
    const repo = { owner: target.owner, name: target.name };
    return {
      async head() {
        const h = await readRepoHead(client, repo);
        return { defaultBranch: h.defaultBranch, sha: h.sha };
      },
      file: (path, ref, maxBytes) => readRepoFile(client, repo, path, ref, maxBytes),
      async pulls() {
        const r = await listIssuesAndPulls(client, repo);
        return { pulls: r.pulls.map((p) => ({ number: p.number, title: p.title, state: p.state, dLines: p.dLines })), truncated: r.truncated };
      },
      evidence() {
        return { requests: client.requestLog.map((e) => ({ ...e })), tokenPermissions: client.tokenPermissions ? { ...client.tokenPermissions } : null };
      },
    };
  };
}
