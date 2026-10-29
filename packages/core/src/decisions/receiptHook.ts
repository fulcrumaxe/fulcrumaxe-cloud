/**
 * D#7 DP6a-WIRING: what a place that has just committed a decision receipt calls so the receipt block on the item's pull request is brought up to date.
 *
 * The caller names an account and a work item, both ids it holds from its own committed rows, and nothing else: the pull request, the repository and the
 * receipts are all read again from the platform's own records by the implementation (packages/worker `receiptBlock.ts`). It runs AFTER the transaction that
 * wrote the receipt has committed, never inside it, and it never throws: a failure is the implementation's to log under a fixed code, and the decision stands.
 *
 * The decision is never delayed by the block write. The hook is awaited for at most `RECEIPT_HOOK_DEADLINE_MS` in total (the write itself keeps running in the
 * background past that point and is not cancelled: on a host that freezes after the response it may not finish, and the next receipt, the next sweep or the
 * block's own re-read brings the block up to date). The wait is bounded rather than detached so that, on a serverless function, the write still gets its few
 * seconds before the function is frozen.
 */
export type AfterReceiptHook = (input: { accountId: string; workItemId: string }) => Promise<void>;

/** The most a decision, an announce or a sweep tick waits on the receipt block write, in total. */
export const RECEIPT_HOOK_DEADLINE_MS = 3_000;
/** The fixed line logged when the deadline passed. No ids, no text. */
export const RECEIPT_HOOK_DEADLINE_CODE = 'receipt_block_deadline';

export interface ReceiptHookOptions {
  /** Test seam: the deadline in ms. Default `RECEIPT_HOOK_DEADLINE_MS`. */
  deadlineMs?: number;
  /** Receives the fixed deadline code. Default: console.warn. */
  warn?: (line: string) => void;
}

/** Resolves true when `work` settled in time, false when the deadline came first. Never rejects; the timer is always cleared. */
async function withinDeadline(work: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try {
    // fx-swallow-ok: best-effort by contract; the hook logs its own fixed code, and the committed decision is not undone by a block that could not be written
    return await Promise.race([work.then(() => true as const, () => true as const), late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function startHook(hook: AfterReceiptHook, accountId: string, workItemId: string): Promise<void> {
  try {
    return hook({ accountId, workItemId });
  } catch (err) {
    // fx-swallow-ok: not dropped, handed on as a rejected promise; withinDeadline consumes it and the decision stands
    return Promise.reject(err);
  }
}

/** Calls a hook and swallows anything it throws, so a hook that breaks can never fail the decision that already committed; waits at most the deadline. */
export async function runAfterReceipt(hook: AfterReceiptHook | undefined, accountId: string, workItemId: string | null, opts: ReceiptHookOptions = {}): Promise<void> {
  if (hook === undefined || workItemId === null) return;
  const ok = await withinDeadline(startHook(hook, accountId, workItemId), opts.deadlineMs ?? RECEIPT_HOOK_DEADLINE_MS);
  if (!ok) (opts.warn ?? ((line: string) => console.warn(line)))(RECEIPT_HOOK_DEADLINE_CODE);
}

const BATCH_CONCURRENCY = 4;

/**
 * Several committed receipts at once (a sweep tick): the distinct work items are refreshed a few at a time under ONE total deadline for the whole batch,
 * so a slow GitHub cannot serialise the tick behind it. Items not reached when the deadline passes are left to the next receipt or sweep.
 */
export async function runAfterReceipts(hook: AfterReceiptHook | undefined, items: ReadonlyArray<{ accountId: string; workItemId: string | null }>, opts: ReceiptHookOptions = {}): Promise<void> {
  if (hook === undefined) return;
  const seen = new Set<string>();
  const todo: Array<{ accountId: string; workItemId: string }> = [];
  for (const i of items) {
    if (i.workItemId === null) continue;
    const k = `${i.accountId}/${i.workItemId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    todo.push({ accountId: i.accountId, workItemId: i.workItemId });
  }
  if (todo.length === 0) return;
  let expired = false;
  let next = 0;
  const lane = async (): Promise<void> => {
    while (!expired && next < todo.length) {
      const t = todo[next++]!;
      // fx-swallow-ok: a hook that throws or rejects is that item's loss only; the decision it follows already committed
      await startHook(hook, t.accountId, t.workItemId).catch(() => undefined);
    }
  };
  const all = Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, todo.length) }, lane)).then(() => undefined);
  const ok = await withinDeadline(all, opts.deadlineMs ?? RECEIPT_HOOK_DEADLINE_MS);
  if (!ok) {
    expired = true;
    (opts.warn ?? ((line: string) => console.warn(line)))(RECEIPT_HOOK_DEADLINE_CODE);
  }
}
