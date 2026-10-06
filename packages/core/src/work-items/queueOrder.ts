/**
 * D#2 H26a: the order in which queued work items are picked. Pure, no I/O.
 *
 * `priority` ascending (0 urgent .. 3 low), then `queueRank` ascending with
 * NULL last, then `createdAt`, then `id`. Two different items never compare
 * equal (ids are unique), so this is a strict total order.
 */
export interface QueueOrderKey {
  id: string;
  priority: number;
  queueRank: number | bigint | null;
  createdAt: Date;
}

function cmp(a: number | bigint, b: number | bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareQueueOrder(a: QueueOrderKey, b: QueueOrderKey): number {
  const byPriority = cmp(a.priority, b.priority);
  if (byPriority !== 0) return byPriority;

  if (a.queueRank === null || b.queueRank === null) {
    if (a.queueRank !== null) return -1;
    if (b.queueRank !== null) return 1;
  } else {
    const byRank = cmp(a.queueRank, b.queueRank);
    if (byRank !== 0) return byRank;
  }

  const byCreated = cmp(a.createdAt.getTime(), b.createdAt.getTime());
  if (byCreated !== 0) return byCreated;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
