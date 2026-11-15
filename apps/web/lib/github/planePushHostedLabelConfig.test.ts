import { afterEach, describe, expect, it, vi } from "vitest";

const reported: Array<{ message: string; stage: string }> = [];
vi.mock("@fx/telemetry", async (orig) => ({ ...(await orig<object>()), reportError: (err: unknown, ctx: { stage: string }) => void reported.push({ message: String((err as Error).message), stage: ctx.stage }) }));

import { createLivePlanePushPort, lazyFullCiRepos } from "./planePushHosted";

afterEach(() => void (reported.length = 0));

describe("FX_GATE1_ATTEST_REPOS in the runner routes' GitHub port (D#6 ONE-CI-PER-ITEM)", () => {
  it("a malformed value never makes the port fail to build; labelling is off", async () => {
    const env = { FX_GATE1_ATTEST_REPOS: "not a repo, also bad" } as unknown as NodeJS.ProcessEnv;
    const port = createLivePlanePushPort(env);
    expect(typeof port.ensureFullCiLabel).toBe("function");
    expect(typeof port.verifyPullRequest).toBe("function");
    // Asked for a label, it answers off without minting any token (so it needs no GitHub App at all).
    await expect(port.ensureFullCiLabel({ accountId: "a", codeRepo: "acme/widgets", number: 1 })).resolves.toBe("off");
    expect(reported.map((r) => r.stage)).toEqual(["plane_push.ci_full_repos_config"]);
    // The report names the setting, never the value.
    expect(reported[0]!.message).not.toContain("not a repo");
  });

  it("is reported once, and a good value still lists its repositories", () => {
    const bad = lazyFullCiRepos({ FX_GATE1_ATTEST_REPOS: "###" } as unknown as NodeJS.ProcessEnv);
    expect(bad().size).toBe(0);
    expect(bad().size).toBe(0);
    expect(reported).toHaveLength(1);
    expect([...lazyFullCiRepos({ FX_GATE1_ATTEST_REPOS: "Acme/Widgets" } as unknown as NodeJS.ProcessEnv)()]).toEqual(["acme/widgets"]);
    expect(lazyFullCiRepos({} as unknown as NodeJS.ProcessEnv)().size).toBe(0);
  });
});
