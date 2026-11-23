import { describe, expect, it } from "vitest";
import { ENGINE_RELEASE_UNSET, healthResponse } from "./handler";

/** D#845 ON-8b: health reports `engine_release_unset` to the operator only, and only when told no release is published. */
describe("health: engine_release_unset", () => {
  const env = { CRON_SECRET: "s3cret-for-the-test" } as Record<string, string>;
  const bearer = "Bearer s3cret-for-the-test";
  it("names the code in the operator's detail when no release is published, and leaves it out otherwise", async () => {
    const unset = await healthResponse(env, bearer, Date.now(), undefined, true).json() as { unconfigured?: string[] };
    expect(unset.unconfigured).toContain(ENGINE_RELEASE_UNSET);
    const set = await healthResponse(env, bearer, Date.now(), undefined, false).json() as { unconfigured?: string[] };
    expect(set.unconfigured).not.toContain(ENGINE_RELEASE_UNSET);
  });
  it("shows an anonymous caller nothing of it", async () => {
    const body = await healthResponse(env, null, Date.now(), undefined, true).json() as { unconfigured?: string[] };
    expect(JSON.stringify(body)).not.toContain(ENGINE_RELEASE_UNSET);
    expect(body.unconfigured).toBeUndefined();
  });
});
