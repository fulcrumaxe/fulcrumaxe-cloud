/**
 * The poll pacing of the workflows, written out by hand for the tests (not read from the source): each tier is [elapsed time at which it starts, pause]. A source
 * pin in workItemAdvancePollTiers.test.ts holds these equal to the workflow's own tables. `pollsFor` is the number of asks a wait of `budgetMs` makes before its
 * budget is used up (the loop sleeps one pause, adds it to the budget, asks, and stops once the budget is reached).
 */
export type Tiers = ReadonlyArray<readonly [number, number]>;
const MIN = 60_000;
export const BUILD_TIERS: Tiers = [[0, MIN], [10 * MIN, 2 * MIN], [60 * MIN, 4 * MIN]];
export const REVIEW_TIERS: Tiers = [[0, 30_000], [5 * MIN, MIN], [20 * MIN, 2 * MIN]];
export const CI_TIERS: Tiers = [[0, MIN], [10 * MIN, 2 * MIN], [30 * MIN, 5 * MIN]];
export const FOLLOW_TIERS: Tiers = [[0, MIN], [5 * MIN, 2 * MIN], [30 * MIN, 5 * MIN]];

export function pauseAt(tiers: Tiers, elapsedMs: number): number {
  return [...tiers].reverse().find(([start]) => elapsedMs >= start)![1];
}

/** The elapsed times at which each ask's sleep starts, until the budget is reached. */
export function pollStarts(tiers: Tiers, budgetMs: number): number[] {
  const starts: number[] = [];
  for (let elapsed = 0; elapsed < budgetMs; elapsed += pauseAt(tiers, elapsed)) starts.push(elapsed);
  return starts;
}
export const pollsFor = (tiers: Tiers, budgetMs: number): number => pollStarts(tiers, budgetMs).length;

/** The asks a wait makes when `offsetMs` of other time (the pending credit) has already gone by on the same pacing, until `budgetMs` of its own is used up. */
export function pollsAfter(tiers: Tiers, offsetMs: number, budgetMs: number): number {
  let n = 0;
  for (let own = 0; own < budgetMs; n++) own += pauseAt(tiers, offsetMs + own);
  return n;
}
/** The elapsed time after `n` asks. */
export function elapsedAfter(tiers: Tiers, n: number): number {
  let elapsed = 0;
  for (let i = 0; i < n; i++) elapsed += pauseAt(tiers, elapsed);
  return elapsed;
}
/** What the k-th read answers when the wait is in `phases` (each [until elapsed ms, answer]); `last` after the final phase. Read k happens after k pauses. */
export function readAt<T>(tiers: Tiers, k: number, phases: ReadonlyArray<readonly [number, T]>, last: T): T {
  const elapsed = elapsedAfter(tiers, k);
  return phases.find(([until]) => elapsed < until)?.[1] ?? last;
}
