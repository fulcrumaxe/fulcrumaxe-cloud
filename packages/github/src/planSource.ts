import type { RepoPermission } from "@fx/trust";
import { createPlanReadClient, PlanReadError, type PlanReadDeps, type PlanReadTarget } from "./planReadClient.js";
import { listDiscussionComments, listDiscussions, listIssuesAndPulls, readAuthorPermission, readRepoFile, readRepoHead, type IssuesAndPulls } from "./planReaders.js";

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
  discussions(): Promise<{ discussions: Array<{ number: number; title: string; body: string; closed: boolean; authorLogin: string | null }>; truncated: boolean }>;
  discussionComments(number: number): Promise<{ comments: Array<{ body: string; createdAt: string; authorLogin: string | null }>; truncated: boolean }>;
  issues(): Promise<{ issues: Array<{ number: number; title: string; state: "open" | "closed" }>; truncated: boolean }>;
  authorPermission(login: string): Promise<RepoPermission>;
  evidence(): { requests: Array<{ method: string; path: string; status: number }>; tokenPermissions: Record<string, string> | null };
}

export function createPlanSourceFactory(deps: PlanReadDeps): (target: PlanReadTarget) => PlanSourceShape {
  const open = createPlanReadClient(deps);
  return (target) => {
    const client = open(target);
    const repo = { owner: target.owner, name: target.name };
    // The issues list holds issues and pull requests: it is read once and served to both `pulls()` and `issues()`.
    let listing: Promise<IssuesAndPulls> | undefined;
    const list = (): Promise<IssuesAndPulls> => (listing ??= listIssuesAndPulls(client, repo));
    return {
      async head() {
        const h = await readRepoHead(client, repo);
        return { defaultBranch: h.defaultBranch, sha: h.sha };
      },
      file: (path, ref, maxBytes) => readRepoFile(client, repo, path, ref, maxBytes),
      async pulls() {
        const r = await list();
        // The merged-pull-request read decides which tasks are done, so a budget that ran out is an error here, never a short list.
        if (r.budgetExhausted) throw new PlanReadError("request_budget_exceeded");
        return { pulls: r.pulls.map((p) => ({ number: p.number, title: p.title, state: p.state, dLines: p.dLines })), truncated: r.truncated };
      },
      discussions: () => listDiscussions(client, repo),
      async discussionComments(number) {
        const r = await listDiscussionComments(client, repo, number);
        return { comments: r.comments.map((c) => ({ body: c.body, createdAt: c.createdAt, authorLogin: c.authorLogin })), truncated: r.truncated };
      },
      async issues() {
        const r = await list();
        return { issues: r.issues.map((i) => ({ number: i.number, title: i.title, state: i.state })), truncated: r.truncated };
      },
      authorPermission: (login) => readAuthorPermission(client, repo, login),
      evidence() {
        return { requests: client.requestLog.map((e) => ({ ...e })), tokenPermissions: client.tokenPermissions ? { ...client.tokenPermissions } : null };
      },
    };
  };
}
