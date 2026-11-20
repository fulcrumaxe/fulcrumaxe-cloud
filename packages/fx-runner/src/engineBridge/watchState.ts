/**
 * Whether anyone is watching a bridged repo's detail (D#845 watch mode). The cloud says so in two ways: a signed `watch` command (`until`), and `watch_until` on an accepted
 * ingest reply. Both only EXTEND the watch (a replayed or stale answer never shortens one), and neither may reach further than `WATCH_MAX_AHEAD_MS` past the runner's own clock,
 * so a wrong answer holds full uploads for ten minutes at most. A watch ends `WATCH_GRACE_MS` after its `until`: the person who just closed the tab may come straight back.
 */
export const WATCH_GRACE_MS = 15 * 60_000;
export const WATCH_MAX_AHEAD_MS = 600_000;

export class WatchState {
  private untilMs: number | null = null;

  constructor(private readonly now: () => number) {}

  /** Extends the watch to `untilMs` (never past ten minutes from now, never shorter than what is held). A value that is not a finite time, or is not ahead of now, is ignored. */
  extend(untilMs: number): void {
    // A watch that is already over (a late or replayed answer) starts nothing: only the grace after a real one is kept.
    if (!Number.isFinite(untilMs) || untilMs <= this.now()) return;
    const capped = Math.min(untilMs, this.now() + WATCH_MAX_AHEAD_MS);
    if (this.untilMs === null || capped > this.untilMs) this.untilMs = capped;
  }

  /** The held `until` as a time, or null when nothing was ever held. */
  until(): number | null {
    return this.untilMs;
  }

  /** True from the first `until` held until `WATCH_GRACE_MS` after it. A clock that went back keeps it watched, never unwatched early. */
  watched(): boolean {
    return this.untilMs !== null && this.now() < this.untilMs + WATCH_GRACE_MS;
  }
}
