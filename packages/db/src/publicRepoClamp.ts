/** What a live visibility read can say about a repo (the same three answers the runner gates use). */
export type ClampVisibility = 'private' | 'public' | 'unknown';

/**
 * D#845 ON-10e2b (Ruling 89 section 2.4): a repo that is not clearly private never auto-acts. Whatever the stored dial or preset says, the disposition
 * is `ask` for `public` and for `unknown` (a read that failed or timed out is not "private"). Defence in depth for the day a public repo can run the engine:
 * the first public operate must not inherit an Autonomous preset. Pure: the caller reads the visibility, outside any transaction.
 */
export function clampForVisibility<D extends string>(disposition: D, visibility: ClampVisibility): D | 'ask' {
  return visibility === 'private' ? disposition : 'ask';
}
