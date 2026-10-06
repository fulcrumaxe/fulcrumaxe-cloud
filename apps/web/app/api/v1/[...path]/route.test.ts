import { afterEach, describe, expect, it, vi } from "vitest";
import { runActionDeps } from "@fx/api/src/routes/run-actions.js";
import { onboardingDeps } from "@fx/api/src/routes/onboarding.js";
import { parsePreviewResult } from "@fx/pipeline";
import { HttpRunActionSignal } from "@fx/api/src/runActions/httpSignal.js";
import { previewEnabled, setWorkerWiringForTests } from "../../../../lib/worker";
import { getAuthorCheck } from "../../../../lib/github/authorCheck";
import "./route";

/**
 * D#2 VCREDS: importing the /api/v1 catch-all installs the run-action signal seam on the same
 * run-actions module the handler routes through. Both states: nothing is wired until a worker
 * can be built and the kick URL and secret are both set.
 */
afterEach(() => {
  vi.unstubAllEnvs();
  setWorkerWiringForTests();
});

function env(vars: Record<string, string>) {
  for (const name of ["VERCEL_TEAM_ID", "VERCEL_PROJECT_ID", "RUN_ACTION_KICK_URL", "RUN_ACTION_KICK_SECRET"]) vi.stubEnv(name, vars[name] ?? "");
}
const WORKER = { VERCEL_TEAM_ID: "team_1", VERCEL_PROJECT_ID: "prj_1" };
const KICK = { RUN_ACTION_KICK_URL: "https://example.test/api/internal/run-actions/kick", RUN_ACTION_KICK_SECRET: "s" };

describe("the run-action signal seam", () => {
  it("is replaced by the catch-all route (not the null default)", () => {
    expect(runActionDeps.getRunActionSignal.toString()).toContain("workerConfigured");
  });

  it("no signal without a worker, even with the kick variables set", () => {
    env(KICK);
    expect(runActionDeps.getRunActionSignal()).toBeNull();
  });

  it("no signal with a worker and no kick variables, or only one of them", () => {
    env(WORKER);
    expect(runActionDeps.getRunActionSignal()).toBeNull();
    env({ ...WORKER, RUN_ACTION_KICK_URL: KICK.RUN_ACTION_KICK_URL });
    expect(runActionDeps.getRunActionSignal()).toBeNull();
    env({ ...WORKER, RUN_ACTION_KICK_SECRET: "s" });
    expect(runActionDeps.getRunActionSignal()).toBeNull();
  });

  it("the HTTP signal with a worker and both kick variables", () => {
    env({ ...WORKER, ...KICK });
    expect(runActionDeps.getRunActionSignal()).toBeInstanceOf(HttpRunActionSignal);
  });

  it("a provider that yields no options also means no signal", () => {
    env({ ...WORKER, ...KICK });
    setWorkerWiringForTests({ provider: () => null });
    expect(runActionDeps.getRunActionSignal()).toBeNull();
  });
});

/** D#31 AUTHOR-CHECK-WIRE: the retry author check is registered on the same module, unconditionally. */
describe("the retry author-check seam", () => {
  it("is the production provider itself (identity), not the null default", () => {
    expect(runActionDeps.getAuthorCheck).toBe(getAuthorCheck);
  });

  it("builds a check with the GitHub App variables unset (credentials fail at mint, not here)", () => {
    for (const name of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"]) vi.stubEnv(name, "");
    vi.stubEnv("DATABASE_URL_PLATFORM_OPS", "postgres://u:p@127.0.0.1:1/none");
    const check = runActionDeps.getAuthorCheck();
    expect(check).not.toBeNull();
    expect(typeof check!.lookup).toBe("function");
    expect(check!.allowlist).toEqual([]);
  });
});

/** D#31 API-9: the preview result projection is installed; the availability flag is not flipped here (go-live does that). */
describe("the onboarding preview seams", () => {
  it("projects through the pipeline's own parser, by identity", () => {
    expect(onboardingDeps.projectPreviewResult).toBe(parsePreviewResult);
  });

  it("registers the flag-gated check, not the always-false default", () => {
    expect(onboardingDeps.previewAvailable).toBe(previewEnabled);
  });

  it("installs the operator decision over the live process env: only a listed account, with the switch on and a token, needs no model key", () => {
    const OPERATOR = "11111111-1111-4111-8111-111111111111";
    const CUSTOMER = "22222222-2222-4222-8222-222222222222";
    expect(onboardingDeps.isOperatorAccount).not.toBeNull();
    const decide = onboardingDeps.isOperatorAccount!;
    expect(decide(OPERATOR)).toBe(false); // nothing set
    vi.stubEnv("FX_OPERATOR_ACCOUNT_IDS", OPERATOR);
    vi.stubEnv("FX_OPERATOR_CLAUDE_OAUTH_TOKEN", "sk-ant-oat01-FAKE-OPERATOR-TOKEN-FOR-TEST-ONLY");
    expect(decide(OPERATOR)).toBe(false); // no switch
    vi.stubEnv("FX_OPERATOR_SUBSCRIPTION", "on");
    expect(decide(OPERATOR)).toBe(true);
    expect(decide(CUSTOMER)).toBe(false);
    vi.stubEnv("FX_OPERATOR_SUBSCRIPTION", "off"); // the kill switch
    expect(decide(OPERATOR)).toBe(false);
  });

  it("is off by default, and off for a blank or any other flag value, even with a worker that could run it", () => {
    env(WORKER);
    for (const flag of [undefined, "", " ", "off", "ON", "On", "true", "1", "yes", "on "]) {
      vi.stubEnv("FX_ONBOARDING_PREVIEW", flag ?? "");
      expect(onboardingDeps.previewAvailable(), JSON.stringify(flag)).toBe(false);
    }
  });

  it("is on only when the flag is exactly 'on', a worker can be built, and the options carry the prompt builder", () => {
    vi.stubEnv("FX_ONBOARDING_PREVIEW", "on");
    expect(onboardingDeps.previewAvailable()).toBe(false); // no worker ids
    env(WORKER);
    expect(onboardingDeps.previewAvailable()).toBe(true);
    setWorkerWiringForTests({ provider: () => null });
    expect(onboardingDeps.previewAvailable()).toBe(false); // no worker
    setWorkerWiringForTests({ provider: () => ({ vercel: { teamId: "t", projectId: "p", getToken: async () => "x" }, ports: { hooks: { resume: async () => undefined } } }) });
    expect(onboardingDeps.previewAvailable()).toBe(false); // options without the prompt builder
  });
});
