/**
 * Needs that can be decided from the environment or the host alone (T1a). Network-probing needs
 * (`session:*`, `model-key`, ...) arrive with T3 and T9; until then a known need this module cannot
 * evaluate is reported as not met, so its pack is skipped rather than run on an unchecked assumption.
 */
import { readFileSync } from "node:fs";
import type { Pack } from "./manifest.js";
import type { Target } from "./targets.js";

export const BYPASS_ENV = "VERCEL_AUTOMATION_BYPASS_SECRET";
export const STRIPE_RESTRICTED_KEY_ENV = "LIVE_E2E_STRIPE_RESTRICTED_KEY";
/** A restricted TEST-mode key. Live-mode (`rk_live_`) and secret (`sk_`) keys never satisfy `stripe-test`. */
export const STRIPE_TEST_PREFIX = "rk_test_";

export const MAX_LOAD_1M = 18;
export const MIN_MEM_AVAILABLE_BYTES = 4 * 1024 * 1024 * 1024;

export interface HostProbe {
  /** 1-minute load average, or null when it cannot be read. */
  loadavg1(): number | null;
  /** MemAvailable in bytes, or null when it cannot be read. */
  memAvailableBytes(): number | null;
}

export interface NeedsContext {
  env: Record<string, string | undefined>;
  host: HostProbe;
}

export function readHostProbe(): HostProbe {
  return {
    loadavg1() {
      try {
        const first = readFileSync("/proc/loadavg", "utf8").split(" ")[0];
        const n = Number(first);
        return Number.isFinite(n) ? n : null;
      } catch {
        return null;
      }
    },
    memAvailableBytes() {
      try {
        const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readFileSync("/proc/meminfo", "utf8"));
        return m?.[1] === undefined ? null : Number(m[1]) * 1024;
      } catch {
        return null;
      }
    },
  };
}

/** True when the need is satisfied. Unknown or not-yet-evaluable needs are not satisfied. */
export function isNeedMet(need: string, target: Target, ctx: NeedsContext): boolean {
  switch (need) {
    case "bypass": {
      if (!target.protected) return true;
      const v = ctx.env[BYPASS_ENV];
      return typeof v === "string" && v.length > 0;
    }
    case "stripe-test": {
      const v = ctx.env[STRIPE_RESTRICTED_KEY_ENV];
      return typeof v === "string" && v.startsWith(STRIPE_TEST_PREFIX) && v.length > STRIPE_TEST_PREFIX.length;
    }
    case "host-capacity": {
      const load = ctx.host.loadavg1();
      const mem = ctx.host.memAvailableBytes();
      return load !== null && mem !== null && load < MAX_LOAD_1M && mem >= MIN_MEM_AVAILABLE_BYTES;
    }
    default:
      return false;
  }
}

/** The first need (in the pack's declared order) that is not met, or null when all are. */
export function firstUnmetNeed(pack: Pack, target: Target, ctx: NeedsContext): string | null {
  for (const need of pack.needs) {
    if (!isNeedMet(need, target, ctx)) return need;
  }
  return null;
}
