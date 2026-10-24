/**
 * D#6 RUNNER-WAKE: how a runner that holds a wake grant decides when to claim.
 *
 * The grant (on every hello and claim reply of a cloud that has a wake key, for a runner that listed `wake_v1`) names a token and `poll_s`.
 * Between claims the runner asks `GET /api/runner/wake` every `poll_s`. That route reads no database: it answers `{epoch, due_at}`, the time the
 * account last had runner work marked and the earliest time a waiting run becomes due. The runner makes a real claim only when:
 *  - the epoch moved since its last claim, or a due time it has not claimed for has passed (`decideClaim`, a pure function of what it saw, what
 *    it saw at its last claim, and the time; it knows nothing of the transport);
 *  - its safety claim comes round: the cloud's `retry_after`, lined up to the 30-minute wall-clock slot when it is longer than a minute
 *    (`safetyClaimAt`), so a lost wake waits at most one slot and every runner's safety claim lands in the same few minutes;
 *  - the wake route failed 3 times in a row: it claims at once and keeps 60-second claims until a claim brings a grant again (`WakeTracker`).
 *
 * Tiers (stream, poll, claim) are a small state machine so a later push transport fills in the stream tier rather than rewriting the loop.
 * Only `poll` is entered today: `effectiveWakeTransport` maps any transport this build does not know to `poll`.
 */
import { CLAIM_IDLE_RETRY_AFTER_SECONDS, effectiveWakeTransport, type WakeGrant } from "@fulcrumaxe/runner-protocol";

export const WAKE_PATH = "/api/runner/wake";
/** The wall-clock slot the safety claims line up to: the same one the cloud's own backstops use. */
export const WAKE_SLOT_MS = 30 * 60_000;
/** Spread of the safety claim inside the start of its slot, so runners do not all arrive in the same second. */
export const WAKE_SLOT_JITTER_MS = 120_000;
/** Consecutive wake failures after which the runner falls back to plain claims. */
export const WAKE_FAILURES_BEFORE_FALLBACK = 3;
/** The claim cadence while fallen back. */
export const WAKE_FALLBACK_CLAIM_SECONDS = 60;

/** The wake route's 200 reply: exactly two numbers (ms since the epoch); `epoch` 0 when nothing was ever marked, `due_at` null when nothing is due. */
export interface WakeReply {
  epoch: number;
  due_at: number | null;
}

const isMs = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Strict: an object with exactly `epoch` and `due_at`, both whole non-negative milliseconds (`due_at` may be null). Anything else is not a reply. */
export function parseWakeReply(body: unknown): WakeReply | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes("epoch") || !keys.includes("due_at")) return undefined;
  const { epoch, due_at } = body as Record<string, unknown>;
  if (!isMs(epoch) || !(due_at === null || isMs(due_at))) return undefined;
  return { epoch, due_at };
}

/** What the runner saw on its last wake check. */
export interface WakeSeen {
  epoch: number;
  dueAt: number | null;
}

/** What the runner knew when it last claimed: the epoch it had seen (null: none seen yet) and the due time that claim already covered. */
export interface ClaimMark {
  epoch: number | null;
  dueAt: number | null;
}

export type ClaimDecision = { claim: true; reason: "epoch" | "due" | "no_baseline" } | { claim: false };

/**
 * Pure. Whether a wake check means "claim now". With no epoch seen at the last claim (just started), the first check claims: the runner cannot
 * tell whether work arrived in between, and an extra empty claim is cheap while a missed one waits a slot. Epochs are compared for change, not
 * order, so the runner's clock never enters into it; an epoch that went back (a cache eviction) claims once too.
 */
export function decideClaim(seen: WakeSeen, last: ClaimMark, nowMs: number): ClaimDecision {
  if (last.epoch === null) return { claim: true, reason: "no_baseline" };
  if (seen.epoch !== last.epoch) return { claim: true, reason: "epoch" };
  if (seen.dueAt !== null && seen.dueAt <= nowMs && seen.dueAt !== last.dueAt) return { claim: true, reason: "due" };
  return { claim: false };
}

/**
 * Pure. When the next safety claim is due after an idle answer of `retryAfterSeconds`. A minute or less (today's idle answer, a queued-but-blocked
 * answer, the throttle) is kept exactly. Longer, it is moved earlier to the last slot boundary before it, plus up to two minutes, never later
 * than the cloud asked; when no boundary falls inside the wait it is kept as it is.
 */
export function safetyClaimAt(nowMs: number, retryAfterSeconds: number, random: () => number): number {
  const asked = nowMs + retryAfterSeconds * 1000;
  if (retryAfterSeconds <= CLAIM_IDLE_RETRY_AFTER_SECONDS) return asked;
  const boundary = Math.floor(asked / WAKE_SLOT_MS) * WAKE_SLOT_MS;
  if (boundary <= nowMs) return asked;
  return Math.min(asked, boundary + Math.floor(random() * WAKE_SLOT_JITTER_MS));
}

/** `stream` is the push transport a later build adds; nothing enters it yet. `claim` is the fallback to plain claims. */
export type WakeTier = "stream" | "poll" | "claim";

/** How the loop waits after an idle answer. */
export type WakeMode = { kind: "none" } | { kind: "poll"; grant: WakeGrant } | { kind: "fallback" };

/**
 * The runner's wake state: the grant it holds (replaced by each hello and claim reply, dropped when a reply carries none), the tier, the run of
 * failures, and what it saw. No I/O and no clock of its own.
 */
export class WakeTracker {
  private grant: WakeGrant | null = null;
  private tier: WakeTier = "poll";
  private failures = 0;
  private seen: WakeSeen | null = null;
  private last: ClaimMark = { epoch: null, dueAt: null };

  constructor(initial?: WakeGrant | null) {
    if (initial) this.take(initial);
  }

  private take(grant: WakeGrant): void {
    this.grant = grant;
    // Only `poll` is known today: a transport this build does not know is polled (effectiveWakeTransport), so every grant enters the poll tier.
    this.tier = effectiveWakeTransport(grant.transport) === "poll" ? "poll" : "stream";
    this.failures = 0;
  }

  /** A hello reply: its grant, if any, replaces the one held. A hello without one leaves the state alone (the claim decides). */
  onHello(grant: WakeGrant | undefined): void {
    if (grant) this.take(grant);
  }

  /** A 200 claim reply (idle or claimed), sent at `nowMs`. Its grant replaces the one held and ends a fallback; none drops the grant. */
  onClaim(grant: WakeGrant | undefined, nowMs: number): void {
    const seen = this.seen;
    this.last = { epoch: seen?.epoch ?? null, dueAt: seen !== null && seen.dueAt !== null && seen.dueAt <= nowMs ? seen.dueAt : this.last.dueAt };
    if (grant) this.take(grant);
    else this.grant = null;
  }

  /** A successful wake check: resets the failure run, and says whether to claim. */
  onWake(reply: WakeSeen, nowMs: number): ClaimDecision {
    this.failures = 0;
    this.seen = reply;
    return decideClaim(reply, this.last, nowMs);
  }

  /** A failed wake check. Returns true when this failure starts the fallback. */
  onWakeFailure(): boolean {
    this.failures += 1;
    if (this.tier === "poll" && this.failures >= WAKE_FAILURES_BEFORE_FALLBACK) {
      this.tier = "claim";
      return true;
    }
    return false;
  }

  mode(): WakeMode {
    if (this.tier === "claim") return { kind: "fallback" };
    if (this.grant === null) return { kind: "none" };
    return { kind: "poll", grant: this.grant };
  }

  /** For tests and status: the current tier and failure run. */
  state(): { tier: WakeTier; failures: number; holdsGrant: boolean } {
    return { tier: this.tier, failures: this.failures, holdsGrant: this.grant !== null };
  }
}
