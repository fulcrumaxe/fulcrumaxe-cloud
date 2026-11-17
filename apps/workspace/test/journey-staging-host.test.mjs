// apps/workspace/test/journey-staging-host.test.mjs
//
// The live operate journeys may point only at the cloud-staging project's own host and its preview deployments. This table pins which hosts pass and which
// do not, including every look-alike a stranger could register on Vercel, and the origin gate that wraps it (bare https origin, no port, typed twice).
import { afterEach, describe, expect, it, vi } from "vitest";

const loadHelper = async (env = {}) => {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return import("../e2e/helpers/journey.ts");
};

const OK = [
  "cloud-staging.vercel.app",
  "cloud-staging-abc123xyz-formalhosting.vercel.app", // a deployment url: nine characters
  "cloud-staging-git-engine-bridge-eb15b-formalhosting.vercel.app", // a branch url
  "cloud-staging-git-main-formalhosting.vercel.app",
];
const REFUSED = [
  "cloud-staging.vercel.app.evil.com",
  "evilcloud-staging.vercel.app",
  "cloud-staging.vercel.app:8443", // a port is not part of the host
  "CLOUD-STAGING.vercel.app", // uppercase
  "cloud-staging.vercel.app.", // trailing dot
  "user@cloud-staging.vercel.app",
  ["cloud-staging", "formalhosting.vercel.app"].join("-"), // no deployment part at all
  "cloud-staging--formalhosting.vercel.app",
  "cloud-staging-evil-formalhosting.vercel.app", // four letters: not a deployment hash
  "cloud-staging-abc12345-formalhosting.vercel.app", // eight characters
  "cloud-staging-abc1234567-formalhosting.vercel.app", // ten characters
  "cloud-staging-abc-def-ghi-formalhosting.vercel.app",
  "cloud-staging-git--formalhosting.vercel.app",
  "cloud-staging-git-formalhosting.vercel.app",
  "cloud-staging-abc123xyz-formalhosting.vercel.app.evil.com",
  "cloud-staging-abc123xyz-formalhosting.vercel.app:8443",
  "my-cloud-staging-abc123xyz-formalhosting.vercel.app",
  "cloud-staging-abc123xyz-formalhosting.vercel.com",
  "cloud-production.vercel.app",
  "vercel.app",
  "",
];

describe("isStagingHost", () => {
  it.each(OK)("admits %s", async (host) => {
    const { isStagingHost } = await loadHelper();
    expect(isStagingHost(host)).toBe(true);
  });
  it.each(REFUSED)("refuses %j", async (host) => {
    const { isStagingHost } = await loadHelper();
    expect(isStagingHost(host)).toBe(false);
  });
});

describe("liveOrigin", () => {
  afterEach(() => {
    for (const k of ["JOURNEY_LIVE", "JOURNEY_ORIGIN", "JOURNEY_CONFIRM_ORIGIN"]) delete process.env[k];
  });
  const run = async (origin, confirm = origin) => {
    const { liveOrigin } = await loadHelper({ JOURNEY_LIVE: "1", JOURNEY_ORIGIN: origin, JOURNEY_CONFIRM_ORIGIN: confirm });
    return liveOrigin();
  };
  it("accepts a bare https staging origin typed twice", async () => {
    expect(await run("https://cloud-staging.vercel.app")).toBe("https://cloud-staging.vercel.app");
    expect(await run("https://cloud-staging-abc123xyz-formalhosting.vercel.app")).toBe("https://cloud-staging-abc123xyz-formalhosting.vercel.app");
  });
  it.each([
    "https://cloud-staging.vercel.app:8443",
    "https://cloud-staging-abc123xyz-formalhosting.vercel.app:8443",
    "http://cloud-staging.vercel.app",
    "https://cloud-staging.vercel.app/",
    "https://cloud-staging.vercel.app/path",
    "https://user@cloud-staging.vercel.app",
    "https://user:p@cloud-staging.vercel.app",
    "https://cloud-staging.vercel.app.evil.com",
    "https://cloud-staging-evil-formalhosting.vercel.app",
    `https://${["cloud-staging", "formalhosting.vercel.app"].join("-")}`,
  ])("refuses %s even when typed twice", async (origin) => {
    await expect(run(origin)).rejects.toThrow();
  });
  it("refuses an origin that is not typed the same twice", async () => {
    await expect(run("https://cloud-staging.vercel.app", "https://cloud-staging-abc123xyz-formalhosting.vercel.app")).rejects.toThrow();
  });
});
