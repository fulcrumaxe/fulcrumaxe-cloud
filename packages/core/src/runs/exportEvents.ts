import { listRunEvents, type EventsReadCtx, type RunEventDTO } from '../events/read.js';

/** Events read from Postgres per page while streaming an export; bounds memory, not the export's length. */
export const EXPORT_PAGE_SIZE = 1000;

/**
 * D#45 S8: the events of one run, oldest first, as the same `{seq, kind, at,
 * payload}` objects `listRunEvents` returns (payload as stored, already
 * redacted when it was written -- there is no export-only field and no
 * `account_id`).
 *
 * The first page is read before this returns, so an unknown, malformed or
 * other-tenant run id throws `NotFoundError` here, ahead of any response
 * byte; the returned generator then reads the rest one keyset page at a
 * time, each through `listRunEvents` (so each page re-checks tenancy).
 */
export async function exportRunEvents(ctx: EventsReadCtx, runId: string): Promise<AsyncGenerator<RunEventDTO>> {
  const first = await listRunEvents(ctx, runId, { limit: EXPORT_PAGE_SIZE });
  return (async function* pages() {
    let page = first;
    for (;;) {
      yield* page.data;
      if (page.next_after_seq === null) return;
      page = await listRunEvents(ctx, runId, { afterSeq: page.next_after_seq, limit: EXPORT_PAGE_SIZE });
    }
  })();
}
