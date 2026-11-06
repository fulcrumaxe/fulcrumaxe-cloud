import type { Pool } from "pg";
import { markWorkPending } from "@fx/core/src/pendingWork.js";
import { REPO_INSTRUCTION_FILES, type RepoInstructionFile } from "@fx/core/src/memory/repoFileImport.js";
import { markRepoFilesDue } from "@fx/core/src/memory/repoFileSweep.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import type { GithubWebhookEventName, GithubWebhookPayload } from "@fx/github";
import { readDefaultBranchPush } from "./planeParityWake";

/**
 * D#601 MEM-5b: the marks for the repo instruction file import. A connect marks both files of each connected repository; a push to the DEFAULT branch whose changed
 * paths name CLAUDE.md or AGENTS.md at the root marks that file. Both only write the due row (and the pending-work hint): no outbound call. The existing
 * setup-request-check sweep reads the files.
 */
/** A push lists at most 20 commits; a push at that size may have hidden commits, so both files are marked rather than guessed at. */
const PUSH_COMMITS_CAP = 20;

/** The instruction files a default-branch push changed (added, modified or removed). Pure. */
export function instructionFilesChangedByPush(eventName: string, payload: unknown): RepoInstructionFile[] {
  if (readDefaultBranchPush(eventName, payload) === null) return [];
  const commits = (payload as { commits?: unknown }).commits;
  if (!Array.isArray(commits)) return [];
  if (commits.length >= PUSH_COMMITS_CAP) return [...REPO_INSTRUCTION_FILES];
  const touched = new Set<string>();
  for (const c of commits) {
    if (typeof c !== "object" || c === null) continue;
    for (const key of ["added", "modified", "removed"] as const) {
      const list = (c as Record<string, unknown>)[key];
      if (Array.isArray(list)) for (const p of list) if (typeof p === "string") touched.add(p);
    }
  }
  return REPO_INSTRUCTION_FILES.filter((f) => touched.has(f));
}

async function mark(pool: Pool, accountId: string, repoIds: readonly string[], paths: readonly RepoInstructionFile[]): Promise<number> {
  const marked = await withTenant(pool, accountId, (client) => markRepoFilesDue(client, { accountId, repoIds, paths }));
  if (marked > 0) void markWorkPending("setup-request-check");
  return marked;
}

export async function wakeRepoInstructionImport(pool: Pool, event: { accountId: string; repoId: string; eventName: GithubWebhookEventName; payload: GithubWebhookPayload }): Promise<number> {
  const paths = instructionFilesChangedByPush(event.eventName, event.payload);
  if (paths.length === 0 || event.repoId === "") return 0;
  return mark(pool, event.accountId, [event.repoId], paths);
}

/** A connect (installation created, repositories added): both files of each repository. Never throws into the connect path. */
export async function wakeRepoInstructionImportOnConnect(pool: Pool, accountId: string, repoIds: readonly string[], warn: (message: string) => void = console.warn): Promise<void> {
  try {
    await mark(pool, accountId, repoIds, REPO_INSTRUCTION_FILES);
  } catch (err) {
    // fx-swallow-ok: the connect already committed; the error name is logged (no id, no message) and a later push or connect marks the files
    warn(`repo instruction wake failed: ${err instanceof Error ? err.name : "unknown"}`);
  }
}
