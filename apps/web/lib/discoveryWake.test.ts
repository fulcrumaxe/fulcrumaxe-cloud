import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPendingHooks } from "@fx/core/src/pendingWork";

// D#483 S4-c2 follow-up: every path that queues a discovery run wakes the proposal-verify tick, and only when a run was actually queued.
const queued = vi.hoisted(() => ({ runs: [] as { id: string; repoId: string }[] }));
const captured = vi.hoisted(() => ({ apply: null as null | ((s: unknown, c: unknown) => Promise<unknown>) }));

vi.mock("@fx/db/src/discoveryRuns", () => ({ queueDiscoveries: vi.fn(async () => queued.runs) }));
vi.mock("@fx/billing/subscriptionSync", () => ({ applyFetchedSubscription: vi.fn(async () => ({ applied: true, activated: { accountId: "a1", subscriptionId: "sub_1" } })) }));
vi.mock("@fx/reconcile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fx/reconcile")>()),
  createStripeSubscriptionsJob: (deps: { apply: (s: unknown, c: unknown) => Promise<unknown> }) => {
    captured.apply = deps.apply;
    return { name: "stripe_subscriptions" };
  },
}));

import { defaultStripeWebhookDeps } from "../app/api/stripe/webhook/handler";
import { stripeSubscriptionsJobFromEnv } from "../app/api/cron/reconcile/handler";
import { defaultInstallCallbackDeps } from "../app/api/github/install/[kind]/callback/handler";
import { wakeDiscoveryDrain } from "./discoveryWake";

const MARKER = "pending:proposal-verify-sweep";
const ONE_RUN = [{ id: "r1", repoId: "p1" }];
let written: Map<string, number>;

beforeEach(() => {
  written = new Map();
  setPendingHooks({ store: { get: async (k) => written.get(k) ?? null, set: async (k, v) => void written.set(k, v), delete: async (k) => void written.delete(k) } });
  vi.stubEnv("DATABASE_URL_APP_USER", "postgres://u:p@127.0.0.1:1/none");
  vi.stubEnv("DATABASE_URL_PLATFORM_OPS", "postgres://u:p@127.0.0.1:1/none");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_FAKE_TEST_ONLY");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_FAKE_TEST_ONLY");
  vi.stubEnv("STRIPE_RECONCILE_KEY", "rk_test_restricted_read_only");
});
afterEach(() => {
  setPendingHooks(null);
  vi.unstubAllEnvs();
});

describe.each([
  ["Stripe activation webhook", () => defaultStripeWebhookDeps().onSubscriptionActivated!({ accountId: "a1", subscriptionId: "sub_1" })],
  [
    "reconcile cron backfill",
    async () => {
      stripeSubscriptionsJobFromEnv({} as never, () => undefined);
      await captured.apply!({}, {});
    },
  ],
  ["install callback", () => defaultInstallCallbackDeps().onDiscoveryQueued!("a1", queued.runs)],
])("%s", (_name, run) => {
  it("marks the proposal-verify tick pending when a run was queued", async () => {
    queued.runs = ONE_RUN;
    await run();
    expect(written.has(MARKER)).toBe(true);
  });
  it("marks nothing when the queue was a no-op", async () => {
    queued.runs = [];
    await run();
    expect(written.has(MARKER)).toBe(false);
  });
});

describe("wakeDiscoveryDrain", () => {
  it("swallows a failed mark and logs the error name only", async () => {
    setPendingHooks({ store: { get: async () => null, set: async () => { throw Object.assign(new Error("secret detail"), { name: "BoomError" }); }, delete: async () => {} } });
    const warn = vi.fn();
    await expect(wakeDiscoveryDrain(ONE_RUN, warn)).resolves.toBeUndefined();
    expect(warn.mock.calls.flat().join(" ")).not.toContain("secret detail");
  });
});
