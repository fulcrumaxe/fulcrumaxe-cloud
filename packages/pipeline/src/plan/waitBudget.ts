import { RUNNER_QUEUE_TTL_MS } from "@fx/runner";

/**
 * D#6 C12 A3: a wait budget that stops counting while the run it bounds is `pending`.
 *
 * A panel seat or the PM waits on an agent run for a fixed time. When the run is a queued runner run it sits in `pending`
 * until a runner on the customer's machine claims it, and that wait is not work the budget was set for. The follower
 * (`createFollowedRunner`) calls `pause()` when it reads a `pending` runner run and `resume()` when it reads anything else
 * (a `pending` sandbox or production run counts against the budget like any other wait); the budget runs only in between.
 * Without a follower that ever pauses it, this is a plain timeout.
 *
 * The pause is not free: all the time spent paused, added up, is capped at `RUNNER_PENDING_CEILING_MS`. When that is
 * reached the budget expires through the same `onExpire` as the normal timeout, so the seat or the PM ends as timed out
 * and nothing can wait on a queue for ever (CWE-835).
 *
 * `pause` and `resume` are idempotent, and nothing fires after `cancel()` or after the budget expired.
 */

/** Slack on top of the queue TTL, so the sweeper's own `queue_ttl` timeout normally lands first and the wait ends on the run's real status. */
export const RUNNER_PENDING_MARGIN_MS = 3_600_000;
/** The most pending time any one wait credits: the runner queue TTL (72 hours) plus a fixed margin. */
export const RUNNER_PENDING_CEILING_MS = RUNNER_QUEUE_TTL_MS + RUNNER_PENDING_MARGIN_MS;

export interface WaitClock {
  pause(): void;
  resume(): void;
  /**
   * D#6 C29: counts `ms` as already spent. A step that was handed back and called again builds a fresh budget, but its run has been
   * working since before; the follower calls this once with the time the run has really been `running`, so the deadline is
   * measured from the run's own record and a re-entry does not reset it. Optional: a clock that cannot do it is a plain timeout.
   */
  consume?(ms: number): void;
}

export class WaitBudget implements WaitClock {
  private remainingMs: number;
  private pendingRemainingMs: number;
  private startedAt: number | null = null;
  private pausedAt: number | null = null;
  private timer: NodeJS.Timeout | undefined;
  private pendingTimer: NodeJS.Timeout | undefined;
  private done = false;

  constructor(
    totalMs: number,
    private readonly onExpire: () => void,
    private readonly now: () => number = Date.now,
    pendingCapMs: number = RUNNER_PENDING_CEILING_MS,
  ) {
    this.remainingMs = totalMs;
    this.pendingRemainingMs = pendingCapMs;
    this.start();
  }

  private expire(): void {
    clearTimeout(this.timer);
    clearTimeout(this.pendingTimer);
    this.timer = undefined;
    this.pendingTimer = undefined;
    this.startedAt = null;
    this.pausedAt = null;
    this.remainingMs = 0;
    if (this.done) return;
    this.done = true;
    this.onExpire();
  }

  private start(): void {
    if (this.done || this.startedAt !== null) return;
    this.startedAt = this.now();
    this.timer = setTimeout(() => this.expire(), this.remainingMs);
  }

  pause(): void {
    if (this.done || this.startedAt === null) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.remainingMs = Math.max(this.remainingMs - (this.now() - this.startedAt), 0);
    this.startedAt = null;
    this.pausedAt = this.now();
    this.pendingTimer = setTimeout(() => this.expire(), this.pendingRemainingMs);
  }

  resume(): void {
    if (this.done) return;
    if (this.pausedAt !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
      this.pendingRemainingMs = Math.max(this.pendingRemainingMs - (this.now() - this.pausedAt), 0);
      this.pausedAt = null;
    }
    this.start();
  }

  consume(ms: number): void {
    if (this.done || !Number.isFinite(ms) || ms <= 0) return;
    if (this.startedAt !== null) {
      // Running: settle what ran so far, take the credit off, and re-arm the timer for what is left.
      clearTimeout(this.timer);
      const at = this.now();
      this.remainingMs = Math.max(this.remainingMs - (at - this.startedAt) - ms, 0);
      this.startedAt = at;
      this.timer = setTimeout(() => this.expire(), this.remainingMs);
    } else {
      this.remainingMs = Math.max(this.remainingMs - ms, 0);
    }
  }

  /** Stops the budget for good. Safe to call twice and after it expired. */
  cancel(): void {
    this.done = true;
    clearTimeout(this.timer);
    clearTimeout(this.pendingTimer);
    this.timer = undefined;
    this.pendingTimer = undefined;
    this.startedAt = null;
    this.pausedAt = null;
  }
}
