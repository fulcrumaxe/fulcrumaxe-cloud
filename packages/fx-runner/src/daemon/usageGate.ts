/**
 * Claim gating on the plan's usage limits (D#6 C43-6). Two states, both ending by themselves:
 *  - blocked: a job reported `usage_limit_reached`. Nothing is claimed in any class until the reported `reset_at` plus a little jitter. Jobs in
 *    hand carry on; each one that hits the limit ends and gets its follow-up run from the cloud. No `reset_at` holds for an hour, a time further
 *    off than a day is cut to a day (the same figures the cloud uses for the follow-up run), and a time already past blocks nothing.
 *  - single: the agent's stream warned that the limit is near. The runner takes a job only while it holds none, until the reported reset (or, when
 *    the warning names none, for a while: each further warning renews it).
 * An `api_key` runner has no plan window, so its gate never blocks. A later report overwrites an earlier one.
 */
import type { LocalOnlyEvent } from "@fulcrumaxe/runner-protocol";

export const DEFAULT_BLOCK_MS = 60 * 60_000;
export const MAX_BLOCK_MS = 24 * 60 * 60_000;
/** How long a warning that names no reset time holds the runner to one job. */
export const DEFAULT_WARNING_MS = 30 * 60_000;
export const MAX_JITTER_MS = 30_000;

export interface UsageState {
  /** No claim in any class. */
  blocked: boolean;
  /** At most one job at a time. */
  single: boolean;
}

export interface UsageGate {
  /** A job's metadata event. Only `usage_limit_reached` matters. */
  observe(event: LocalOnlyEvent): void;
  /** The agent's stream warned that the plan limit is near; `resetsAtMs` is the reset it named, when it named a usable one. */
  warn(info: { resetsAtMs?: number }): void;
  state(): UsageState;
}

export interface UsageGateDeps {
  credentialMode: "subscription" | "api_key";
  now: () => number;
  /** In [0, 1). Default `Math.random`. */
  random?: () => number;
}

export function createUsageGate(deps: UsageGateDeps): UsageGate {
  const random = deps.random ?? Math.random;
  let blockedUntil = 0;
  let singleUntil = 0;
  const live = deps.credentialMode === "subscription";
  return {
    observe(event) {
      if (!live || event.type !== "usage_limit_reached") return;
      const now = deps.now();
      const reset = event.reset_at === undefined ? now + DEFAULT_BLOCK_MS : Date.parse(event.reset_at);
      if (!Number.isFinite(reset) || reset <= now) return;
      blockedUntil = Math.min(reset, now + MAX_BLOCK_MS) + Math.floor(random() * MAX_JITTER_MS);
    },
    warn(info) {
      if (!live) return;
      const now = deps.now();
      const reset = info.resetsAtMs !== undefined && info.resetsAtMs > now ? Math.min(info.resetsAtMs, now + MAX_BLOCK_MS) : now + DEFAULT_WARNING_MS;
      singleUntil = Math.max(singleUntil, reset);
    },
    state() {
      const now = deps.now();
      return { blocked: now < blockedUntil, single: now < singleUntil };
    },
  };
}
