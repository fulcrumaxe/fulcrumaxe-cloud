import type { Parsed } from "./args.js";
import { CliExit, EXIT } from "./errors.js";

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

/** A server that keeps answering with new cursors must not keep the CLI running forever. */
const MAX_PAGES = 500;

/**
 * One page by default (the server's size, or `--limit`); `--all` follows `next_cursor` until the server says there is no more.
 * `--json` shows the API's own page unchanged when there is one page to show, and one merged page (`next_cursor: null`) for `--all`.
 */
export async function listPages<T>(args: Parsed, fetchPage: (query: { limit?: string; cursor?: string }) => Promise<Page<T>>): Promise<Page<T>> {
  const size = args.limit === undefined ? {} : { limit: String(args.limit) };
  let page = await fetchPage(size);
  if (!args.all) return page;
  const data = [...page.data];
  const seen = new Set<string>();
  while (page.next_cursor !== null) {
    if (seen.has(page.next_cursor) || seen.size >= MAX_PAGES) throw new CliExit(EXIT.unexpected, "paging_loop", "the server kept returning pages that never end, so paging stopped");
    seen.add(page.next_cursor);
    page = await fetchPage({ ...size, cursor: page.next_cursor });
    data.push(...page.data);
  }
  return { data, next_cursor: null };
}
