import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { readRepoFacts, type PinTreeSource } from "./contextRulesSave.js";

/**
 * D#600 CX-9b: which pinned paths are not in the repository any more, for the rules list. One read of the default branch's tree, only when the list holds a
 * pin; exact paths only (a pin cannot hold a glob, so every pin qualifies; an exclude is never checked). The answer is a label, never a refusal: a tree that
 * cannot be had says nothing.
 *
 * Fail open, on purpose. No tree reader, no installation, no read scope on a private repository (GitHub answers 404), a GitHub error, a read slower than
 * `boundMs`, or a truncated tree (GitHub cut it, so a path missing from it proves nothing) all answer "no label for any rule". A failure is remembered for
 * `failTtlMs`, so a repository that cannot be read costs one attempt per window, not one per screen load.
 *
 * Cost per list view that holds a pin: a cold read is 3 GitHub requests (the repository, its default branch's ref, the recursive tree). The head sha is
 * remembered for `headTtlMs`, so inside that window a view costs 0 requests; after it, 2 (the head is re-read), and the tree is re-read (a 3rd) only when the
 * head moved. The tree is kept by head sha, as the set of its file paths. The cache is per server process; a serverless instance that starts cold pays the
 * cold read once, and no instance ever shares it, so the numbers above are per instance.
 */
export interface MissingRead { sha: string; files: ReadonlySet<string> }
interface Entry { sha: string; files: ReadonlySet<string> | null; headAt: number; failedAt: number | null }
export interface MissingOptions {
  openTree: () => ((repo: { accountId: string; repoId: string; owner: string; name: string }) => Promise<PinTreeSource>) | null;
  now?: () => number;
  boundMs?: number;
  headTtlMs?: number;
  failTtlMs?: number;
  /** Repositories kept; the oldest read is dropped past it. */
  maxRepos?: number;
}

export function createMissingResolver(opts: MissingOptions) {
  const now = opts.now ?? Date.now;
  const boundMs = opts.boundMs ?? 3_000;
  const headTtlMs = opts.headTtlMs ?? 60_000;
  const failTtlMs = opts.failTtlMs ?? 30_000;
  const maxRepos = opts.maxRepos ?? 16;
  const cache = new Map<string, Entry>();
  const inflight = new Map<string, Promise<MissingRead | null>>();

  const remember = (repoId: string, e: Entry) => {
    cache.delete(repoId);
    cache.set(repoId, e);
    for (const k of cache.keys()) if (cache.size > maxRepos) cache.delete(k);
  };

  async function read(repo: { accountId: string; repoId: string; owner: string; name: string }): Promise<MissingRead | null> {
    const t = now();
    const prev = cache.get(repo.repoId);
    if (prev && prev.failedAt !== null && t - prev.failedAt < failTtlMs) return null;
    if (prev && prev.files && prev.failedAt === null && t - prev.headAt < headTtlMs) return { sha: prev.sha, files: prev.files };
    try {
      const open = opts.openTree();
      if (open === null) throw new Error("no tree reader");
      const source = await open(repo);
      const head = await source.headSha();
      if (head === null) throw new Error("no head");
      if (prev && prev.files && prev.sha === head) {
        remember(repo.repoId, { ...prev, headAt: t, failedAt: null });
        return { sha: head, files: prev.files };
      }
      const tree = await source.tree(head);
      if (tree === null || tree.truncated) throw new Error("no usable tree");
      const files = new Set<string>();
      for (const e of tree.entries) if (e.type === "blob") files.add(e.path);
      remember(repo.repoId, { sha: head, files, headAt: t, failedAt: null });
      return { sha: head, files };
    } catch {
      // fx-swallow-ok: a tree that cannot be read means no label, never a failed list; the failure is remembered so it is not retried on every screen load
      remember(repo.repoId, { sha: prev?.sha ?? "", files: prev?.files ?? null, headAt: prev?.headAt ?? 0, failedAt: t });
      return null;
    }
  }

  /** The tree for a repository, or null; never throws and never takes longer than `boundMs` (a read that outlives it still fills the cache for the next view). */
  async function treeFor(repo: { accountId: string; repoId: string; owner: string; name: string }): Promise<MissingRead | null> {
    let p = inflight.get(repo.repoId);
    if (!p) {
      p = read(repo).finally(() => inflight.delete(repo.repoId));
      inflight.set(repo.repoId, p);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), boundMs);
    });
    try {
      return await Promise.race([p, cap]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The sha each missing pin is missing at, by rule id. Empty when there is no pin or the tree cannot be had. */
  async function missingPins(
    pool: Pool,
    who: { accountId: string; userId: string },
    target: { repoId: string } | { workItemId: string },
    rules: ReadonlyArray<{ id: string; kind: string; path: string }>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!rules.some((r) => r.kind === "pin")) return out;
    try {
      const facts = await withTenant(pool, who.accountId, who.userId, (c) =>
        readRepoFacts(c, who.accountId, "repoId" in target ? { scope: "repo", repoId: target.repoId } : { scope: "item", workItemId: target.workItemId }),
      );
      if (!facts || facts.repo_id === null || !facts.gh_owner || !facts.gh_name || facts.installation_id === null) return out;
      const got = await treeFor({ accountId: who.accountId, repoId: facts.repo_id, owner: facts.gh_owner, name: facts.gh_name });
      if (got === null) return out;
      for (const r of rules) if (r.kind === "pin" && !got.files.has(r.path)) out.set(r.id, got.sha);
    } catch {
      // fx-swallow-ok: the facts read failed; the list is still the list, with no labels
      return new Map();
    }
    return out;
  }

  return { missingPins, treeFor, clear: () => cache.clear() };
}
