import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Production wiring of the verify stage's wake: the REAL start-up hook (instrumentation register -> installPendingWork -> the real kick hook -> the real kicker) and the
// REAL wake function that Verify again (operatorMoves.ts), the deploy-order report (runner-cloud deployOrder.ts) and a finished tester run (runStatusWriter.ts) all call.
// Only the outbound fetch, the Stripe check and the clock are replaced. The earlier tests installed a hand-written `kick` hook, so none of them could notice that the
// real request never got past the platform's protection page.
vi.mock("@fx/billing", () => ({ assertStripePriceIdsConfigured: () => undefined }));

import { setPendingHooks } from "@fx/core/src/pendingWork";
import { wakeVerifyStage } from "@fx/core/src/verify/wake";
import { VERIFY_SWEEP_KICK_BODY, VERIFY_SWEEP_KICK_HEADER, verifySweepKickKey, verifyVerifySweepKick } from "@fx/webhooks";
import { register } from "../instrumentation";

const ENV = ["NEXT_RUNTIME", "DATABASE_URL_APP_USER", "RUN_ACTION_KICK_URL", "CRON_SECRET", "VERCEL_AUTOMATION_BYPASS_SECRET", "VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL", "FX_VERIFY_OWN_HOSTS"] as const;
const SECRET = "cron-secret-for-the-prod-wiring-test";
const KICK_URL = "https://cloud-staging.example.vercel.app/api/internal/run-actions/kick";
let saved: Record<string, string | undefined>;
let sent: Array<{ url: string; headers: Record<string, string>; body: string }>;
let status: number;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.NEXT_RUNTIME = "nodejs";
  delete process.env.DATABASE_URL_APP_USER;
  process.env.CRON_SECRET = SECRET;
  process.env.RUN_ACTION_KICK_URL = KICK_URL;
  for (const k of ["VERCEL_AUTOMATION_BYPASS_SECRET", "VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL", "FX_VERIFY_OWN_HOSTS"]) delete process.env[k];
  sent = [];
  status = 202;
  vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), headers: init.headers as Record<string, string>, body: String(init.body) });
    return new Response(null, { status });
  }) as never);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setPendingHooks(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function wakeAndWait(): Promise<void> {
  wakeVerifyStage();
  await vi.advanceTimersByTimeAsync(6000);
}

describe("the verify stage wake, through the hooks the server installs at start-up", () => {
  it("sends the signed kick to the sweep route on the kick URL's origin", async () => {
    await register();
    await wakeAndWait();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://cloud-staging.example.vercel.app/api/cron/proposal-verify-sweep");
    expect(sent[0]!.body).toBe(VERIFY_SWEEP_KICK_BODY);
    expect(verifyVerifySweepKick(sent[0]!.headers[VERIFY_SWEEP_KICK_HEADER]!, sent[0]!.body, verifySweepKickKey(SECRET), Math.floor(Date.now() / 1000))).toBe(true);
    expect(JSON.stringify(sent)).not.toContain(SECRET);
  });

  it("without the start-up install nothing is sent (the hook is what routes the wake to the sender)", async () => {
    await wakeAndWait();
    expect(sent).toHaveLength(0);
  });

  it("on a protected Vercel deployment the kick carries the automation bypass as a header, never in the URL", async () => {
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-secret-for-the-test";
    process.env.VERCEL_URL = "cloud-staging.example.vercel.app";
    await register();
    await wakeAndWait();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers["x-vercel-protection-bypass"]).toBe("bypass-secret-for-the-test");
    expect(sent[0]!.url).not.toContain("bypass");
    expect(sent[0]!.headers["x-vercel-set-bypass-cookie"]).toBeUndefined();
  });

  it("a foreign *.vercel.app kick URL gets no header, even though the suffix matches; the secret is not on stdout either", async () => {
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass-secret-for-the-test";
    process.env.VERCEL_URL = "cloud-staging.example.vercel.app";
    process.env.RUN_ACTION_KICK_URL = "https://someone-elses-project.vercel.app/api/internal/run-actions/kick";
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    status = 401;
    await register();
    await wakeAndWait();
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain("bypass-secret-for-the-test");
    expect(out.mock.calls.map((c) => String(c[0])).join("")).not.toContain("bypass-secret-for-the-test");
  });

  it("a refused kick (the platform's 401 page) is reported on stdout instead of vanishing", async () => {
    status = 401;
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await register();
    await wakeAndWait();
    expect(sent).toHaveLength(1);
    const lines = out.mock.calls.map((c) => String(c[0])).join("");
    expect(lines).toContain("verify_sweep_kick.refused");
    expect(lines).not.toContain(SECRET);
  });
});
