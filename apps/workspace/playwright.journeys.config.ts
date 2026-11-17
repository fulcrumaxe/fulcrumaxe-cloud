// apps/workspace/playwright.journeys.config.ts
//
// The live run of the operate journeys (e2e/journey-engine-operate.spec.ts) against a deployed app, as the signed-in owner. It starts no server and
// routes nothing. It refuses to start unless JOURNEY_LIVE=1, the origin is named twice (JOURNEY_ORIGIN and JOURNEY_CONFIRM_ORIGIN) and is a staging host
// (cloud-staging.vercel.app or a *-formalhosting.vercel.app preview of that project), and the saved sign-in (JOURNEY_STORAGE_STATE) is an existing file.
// Steps nothing takes back by itself (halt, stop an agent, operate off) also need JOURNEY_CONFIRM_REPO, checked in the spec. Waits are real: a command
// takes minutes, an agent up to 15, so there is one worker and a long test timeout.
// The dry run needs none of this: `pnpm --filter workspace exec playwright test e2e/journey-engine-operate.spec.ts`.
import { defineConfig, devices } from "@playwright/test";
import { liveOrigin, storageStateFile } from "./e2e/helpers/journey";

const origin = liveOrigin();
if (origin === null) throw new Error("a live journey run needs JOURNEY_LIVE=1, JOURNEY_ORIGIN, JOURNEY_CONFIRM_ORIGIN and JOURNEY_STORAGE_STATE");
const storageState = storageStateFile();

export default defineConfig({
  testDir: "./e2e",
  testMatch: "journey-engine-operate.spec.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60 * 60_000,
  expect: { timeout: Number(process.env.JOURNEY_WAIT_MS ?? 20 * 60_000) },
  reporter: [["list"]],
  use: { baseURL: origin, storageState, trace: "retain-on-failure" },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }],
});
