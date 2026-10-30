import { BlockPlacementError, replaceBlock } from "./markers.js";
import { renderReceiptBlock, type BlockReceipt } from "./render.js";
import type { ReversalPricePort } from "./price.js";

/** The slice of the `receipt_block` installation client this writer uses (packages/github `createInstallationHttp`). */
export interface BlockHttp {
  request(req: { method: "GET" | "PATCH"; path: string; query?: Record<string, string | number>; body?: unknown }): Promise<{ status: number; body: unknown }>;
}

export interface WriteBlockInput {
  http: BlockHttp;
  owner: string;
  name: string;
  /**
   * The pull request the platform opened for this work item. The caller reads it from the item's own record (same account, same repository),
   * never from a receipt, a run's prompt or model text; the client is pinned to this number, so it cannot reach another.
   */
  prNumber: number;
  /**
   * The head this block is written for: its check runs are what the write is measured against. Absent, it is the head of the pinned pull request
   * as GitHub answers the read the writer makes anyway, so a caller never has to keep a head of its own.
   */
  headSha?: string;
  receipts: readonly BlockReceipt[];
  price: ReversalPricePort;
  now: () => Date;
}

/** The measurement C22 B3 asks for. It is recorded, not a threshold. */
export interface BlockMeasurement {
  headSha: string;
  /** When the body write was made: GitHub's own `updated_at` of the pull request when it answered one, else the local clock. */
  blockWrittenAt: Date;
  checkRuns: number;
  /** The earliest `started_at` among the head's check runs; null with no runs. */
  firstCheckStartedAt: Date | null;
  /** blockWrittenAt minus firstCheckStartedAt, in milliseconds; null with no runs. */
  lagMs: number | null;
  /** True when some check run on the head was still going, or finished after the write: the block was in the body before the last check completed. */
  beforeCiFinished: boolean;
  /** True when every check run had already completed before the write: counted as a miss, never dropped silently. No runs is not a miss. */
  miss: boolean;
}

export type WriteBlockResult =
  | { written: true; changed: boolean; measurement: BlockMeasurement }
  | { written: false; reason: "pr_not_open" | "block_unplaceable" | "pr_unreadable" | "pr_write_refused" | "check_runs_unreadable"; status?: number };

const MAX_PAGES = 10;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

interface CheckRun {
  started_at?: unknown;
  completed_at?: unknown;
}

const time = (v: unknown): Date | null => {
  const d = typeof v === "string" ? new Date(v) : null;
  return d !== null && Number.isFinite(d.getTime()) ? d : null;
};

/** Every check run on a head, paged. null when GitHub answers anything but a listing. */
async function listCheckRuns(http: BlockHttp, base: string, sha: string): Promise<CheckRun[] | null> {
  const all: CheckRun[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await http.request({ method: "GET", path: `${base}/commits/${sha}/check-runs`, query: { per_page: 100, page } });
    const b = res.body as { total_count?: unknown; check_runs?: unknown } | null;
    if (res.status !== 200 || b === null || !Array.isArray(b.check_runs)) return null;
    all.push(...(b.check_runs as CheckRun[]));
    if (b.check_runs.length < 100 || (typeof b.total_count === "number" && all.length >= b.total_count)) break;
  }
  return all;
}

/**
 * Puts the receipt block on an open pull request and measures it against the head's CI (D#7 DP6a, C22 B3 and B4).
 *
 * It reads the current body, replaces only the text between the markers (appending the pair when it is absent) and writes the body back with a
 * PATCH whose only key is `body`. GitHub's update has no conditional write, so a person who edits the body between the read and the write can
 * lose that edit: accepted, and stated in the PR. A closed or merged pull request is not written to. A body that would not change is not sent.
 */
export async function writeReceiptBlock(input: WriteBlockInput): Promise<WriteBlockResult> {
  const base = `/repos/${input.owner}/${input.name}`;
  const prPath = `${base}/pulls/${input.prNumber}`;
  const pr = await input.http.request({ method: "GET", path: prPath });
  const prBody = pr.body as { state?: unknown; merged?: unknown; body?: unknown; updated_at?: unknown; head?: unknown } | null;
  if (pr.status !== 200 || prBody === null || typeof prBody !== "object") return { written: false, reason: "pr_unreadable", status: pr.status };
  if (prBody.state !== "open") return { written: false, reason: "pr_not_open" };
  const current = typeof prBody.body === "string" ? prBody.body : "";
  const headSha = input.headSha ?? (isObject(prBody.head) ? prBody.head.sha : undefined);
  if (typeof headSha !== "string" || !SHA.test(headSha)) return { written: false, reason: "pr_unreadable", status: pr.status };
  let next: string;
  try {
    next = replaceBlock(current, renderReceiptBlock(input.receipts, { price: input.price, merged: false }));
  } catch (err) {
    if (err instanceof BlockPlacementError) return { written: false, reason: "block_unplaceable" };
    throw err;
  }
  let changed = false;
  let writtenAt = input.now();
  if (next !== current) {
    const res = await input.http.request({ method: "PATCH", path: prPath, body: { body: next } });
    if (res.status !== 200) return { written: false, reason: "pr_write_refused", status: res.status };
    changed = true;
    writtenAt = time((res.body as { updated_at?: unknown } | null)?.updated_at) ?? input.now();
  }
  // Read after the write: a run that completed before the write is then a fact, not a guess.
  const runs = await listCheckRuns(input.http, base, headSha);
  if (runs === null) return { written: false, reason: "check_runs_unreadable" };
  const starts = runs.map((r) => time(r.started_at)).filter((d): d is Date => d !== null);
  const first = starts.length > 0 ? new Date(Math.min(...starts.map((d) => d.getTime()))) : null;
  const completions = runs.map((r) => time(r.completed_at));
  const stillRunning = completions.some((c) => c === null);
  const lastCompleted = completions.length > 0 && !stillRunning ? Math.max(...completions.map((c) => c!.getTime())) : null;
  const beforeCiFinished = runs.length === 0 || stillRunning || writtenAt.getTime() < lastCompleted!;
  return {
    written: true,
    changed,
    measurement: {
      headSha,
      blockWrittenAt: writtenAt,
      checkRuns: runs.length,
      firstCheckStartedAt: first,
      lagMs: first === null ? null : writtenAt.getTime() - first.getTime(),
      beforeCiFinished,
      miss: runs.length > 0 && !beforeCiFinished,
    },
  };
}
