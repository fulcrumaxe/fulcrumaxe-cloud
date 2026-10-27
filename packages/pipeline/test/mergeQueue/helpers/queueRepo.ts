import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { createGitHubMergeGatePort } from "../../../src/build/githubMergePort.js";
import { runMergeGate } from "../../../src/build/mergeGate.js";
import { enqueueEntry, getEntry, readQueue, type MergeQueueEntry, type QueueTickDeps, type StartDeltaReview } from "../../../src/mergeQueue/index.js";
import { startMergeTlsGitHub, type MergeTlsGitHub, type MergeWorld } from "../../review/helpers/fakeGitHubMergeTls.js";
import { seedAccount, seedRepo, seedWorkItem } from "../../build/helpers/seed.js";
import type { GitHubHttp } from "../../../src/build/githubMergePort.js";

/**
 * D#519 MQ3-b test world: ONE repository with several pull requests, each served by its own strict TLS fake (the fake models one pull
 * request) behind a router that sends every request to the pull request it names, so the whole repo's GitHub traffic arrives in one
 * ordered list. The head, refreshed head and default-branch tip of PR n are unique to it, so the router can find the right world from
 * any path (a compare, a commit, a tree, a check-run list). The default branch is shared in the one way that matters: when a pull
 * request merges, every other open one falls behind it.
 */
export const BOT = "fulcrumaxe-app[bot]";
export const T0 = new Date("2026-10-26T10:00:00Z");

/** A 40-hex sha that is unique to (pr, kind): the pr number in hex, then the kind's letter, repeated. */
export const shaOf = (pr: number, kind: "head" | "fresh" | "tip"): string => `${pr.toString(16).padStart(2, "0")}${({ head: "a", fresh: "b", tip: "c" } as const)[kind]}`.repeat(14).slice(0, 40);
const reverse = (s: string) => [...s].reverse().join("");

export interface RepoCall {
  pr: number | null;
  method: string;
  path: string;
  query?: string;
}

export interface QueueItem {
  pr: number;
  workItemId: string;
  entryId: string;
  g: MergeTlsGitHub;
  head: string;
  fresh: string;
}

export interface QueueRepo {
  accountId: string;
  repoId: string;
  http: GitHubHttp;
  calls: RepoCall[];
  items: Map<number, QueueItem>;
  /** Everything the fakes saw, one list, in order. */
  mergeCalls(): number[];
  addItem(pr: number, opts?: { approvedAt?: Date; world?: Partial<MergeWorld>; state?: "queued" }): Promise<QueueItem>;
  entry(pr: number): Promise<MergeQueueEntry>;
  queue(): Promise<MergeQueueEntry[]>;
  deps(over?: Partial<QueueTickDeps> & { autoMerge?: boolean }): QueueTickDeps;
  close(): Promise<void>;
  /** The default branch moved: every other open pull request is behind it. */
  mainMoved(exceptPr: number): void;
}

export async function startQueueRepo(db: { admin: PoolClient; runWriterPool: Pool; pureAppUserPool: Pool }, opts: { onDeltaReview?: StartDeltaReview } = {}): Promise<QueueRepo> {
  const accountId = randomUUID();
  const repoId = randomUUID();
  await seedAccount(db.admin, accountId);
  await seedRepo(db.admin, accountId, repoId);
  const items = new Map<number, QueueItem>();
  const calls: RepoCall[] = [];
  const byUnique = new Map<string, QueueItem>();
  const tenant = <T>(id: string, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, id, fn);

  const http: GitHubHttp = {
    async request(req) {
      const path = req.path;
      const pull = /\/pulls\/(\d+)/.exec(path);
      let item: QueueItem | undefined = pull ? items.get(Number(pull[1])) : undefined;
      if (!item) for (const sha of path.match(/[0-9a-f]{40}/g) ?? []) if ((item = byUnique.get(sha))) break;
      item ??= items.values().next().value as QueueItem | undefined;
      if (!item) throw new Error("queueRepo: no pull request registered");
      calls.push({ pr: pull ? Number(pull[1]) : item.pr, method: req.method, path, ...(req.query ? { query: JSON.stringify(req.query) } : {}) });
      return item.g.http.request(req);
    },
  };

  const port = createGitHubMergeGatePort({
    http,
    resolveRepo: async () => ({ owner: "acme", name: "widgets" }),
    markReadyForHumanMerge: async () => undefined,
    sleep: async () => undefined,
    mergeablePollLimit: 3,
  });

  const repo: QueueRepo = {
    accountId,
    repoId,
    http,
    calls,
    items,
    mergeCalls: () => calls.filter((c) => c.method === "PUT" && c.path.endsWith("/merge")).map((c) => c.pr!),
    async addItem(pr, o = {}) {
      const workItemId = randomUUID();
      await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: pr });
      const head = shaOf(pr, "head");
      const fresh = shaOf(pr, "fresh");
      for (const role of ["code-reviewer", "acceptance-tester"]) {
        await db.admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, $3, 'production', 'succeeded', '{"verdict":"pass"}', $4)`, [accountId, workItemId, role, head]);
      }
      const g = await startMergeTlsGitHub({ prNumber: pr, headSha: head, refreshedHeadSha: fresh, baseTipSha: shaOf(pr, "tip"), baseShas: [shaOf(pr, "tip")], refreshAuthorLogin: BOT, ...o.world });
      const created = await tenant(accountId, (c) => enqueueEntry(c, { accountId, repoId, workItemId, prNumber: pr, headSha: head, approvedAt: o.approvedAt ?? T0 }));
      const item: QueueItem = { pr, workItemId, entryId: created.entry.id, g, head, fresh };
      items.set(pr, item);
      for (const sha of [head, fresh, shaOf(pr, "tip"), reverse(head), reverse(fresh)]) byUnique.set(sha, item);
      return item;
    },
    entry: async (pr) => (await tenant(accountId, (c) => getEntry(c, accountId, items.get(pr)!.entryId)))!,
    queue: () => tenant(accountId, (c) => readQueue(c, accountId, repoId)),
    mainMoved(exceptPr) {
      for (const [n, it] of items) if (n !== exceptPr && !it.g.world.merged) it.g.world.behindBy += 1;
    },
    deps(over = {}) {
      const { autoMerge = true, ...rest } = over;
      return {
        github: port,
        inTenant: tenant,
        ourLogin: BOT,
        gate: async ({ entry, headSha, expectedSignals }) =>
          runMergeGate(
            { pool: db.runWriterPool, github: port, isAutoMergeAllowed: async () => autoMerge, requestReviews: async () => undefined },
            { accountId, workItemId: entry.workItemId!, pr: { repoId, prNumber: entry.prNumber }, tier: "small", securityDiffTriggerFired: false, debaterEnabled: false, expectedSignals, expectedHeadSha: headSha },
          ),
        startDeltaReview: opts.onDeltaReview ?? (async () => ({ started: true, runId: randomUUID() })),
        sleep: async () => undefined,
        pollIntervalMs: 0,
        pollLimit: 4,
        ...rest,
      };
    },
    close: async () => void (await Promise.all([...items.values()].map((i) => i.g.close()))),
  };
  return repo;
}
