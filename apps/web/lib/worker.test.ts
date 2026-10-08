import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateWorkerOptions, Worker } from "@fx/worker";
import { runActionDeps } from "@fx/api/src/routes/run-actions.js";
import { buildPreviewPrompt } from "@fx/pipeline";
import { getWorker, setWorkerWiringForTests, workerConfigured } from "./worker";
import "../app/api/v1/[...path]/route";

/**
 * D#2 VCREDS go-live wiring, both states, over the real production provider (nothing injected
 * but the factory, so no pool opens). The cancel-end-to-end case, with the real sandbox target
 * over a database, is packages/worker/test/vercelCredentials.pg.test.ts.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  setWorkerWiringForTests();
});

function captureFactory() {
  const seen: CreateWorkerOptions[] = [];
  const createWorker = vi.fn(async (options: CreateWorkerOptions) => (seen.push(options), {} as Worker));
  setWorkerWiringForTests({ createWorker });
  return { seen, createWorker };
}

describe("either id absent: the state the routes already handle", () => {
  const cases: [string, Record<string, string | undefined>][] = [
    ["neither", {}],
    ["no team id", { VERCEL_PROJECT_ID: "prj_1" }],
    ["no project id", { VERCEL_TEAM_ID: "team_1" }],
    ["a blank team id", { VERCEL_TEAM_ID: "  ", VERCEL_PROJECT_ID: "prj_1" }],
    ["an empty project id", { VERCEL_TEAM_ID: "team_1", VERCEL_PROJECT_ID: "" }],
  ];
  for (const [name, env] of cases) {
    it(`${name}: no worker, createWorker is never called`, async () => {
      vi.stubEnv("VERCEL_TEAM_ID", "");
      vi.stubEnv("VERCEL_PROJECT_ID", "");
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
      const { createWorker } = captureFactory();
      expect(workerConfigured()).toBe(false);
      expect(await getWorker()).toBeNull();
      expect(createWorker).not.toHaveBeenCalled();
    });
  }
});

describe("both ids present", () => {
  it("the worker is built with the production credentials, the production hooks port and the follower starter", async () => {
    vi.stubEnv("VERCEL_TEAM_ID", "team_1");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_1");
    const { seen } = captureFactory();
    expect(workerConfigured()).toBe(true);
    await getWorker();
    const options = seen[0]!;
    expect([options.vercel.teamId, options.vercel.projectId]).toEqual(["team_1", "prj_1"]);
    // No request context in a test process, and no environment fallback: no token.
    await expect(options.vercel.getToken()).rejects.toThrow("worker: no usable Vercel OIDC token in this invocation");
    // Only the hooks, author-check, follower, (D#6 R3b) repository-visibility and continuation-base ports are supplied; every other port is the production body.
    // The author check is the SAME function the /api/v1 route registers (D#31 AUTHOR-CHECK-WIRE).
    expect(options.ports.authorCheck).toBe(runActionDeps.getAuthorCheck);
    expect(Object.keys(options.ports)).toEqual(["hooks", "authorCheck", "follow", "repoVisibility", "continuationBase"]);
    expect(typeof options.ports.repoVisibility?.visibility).toBe("function");
    expect(Object.keys(options.ports.hooks)).toEqual(["resume"]);
    expect(typeof options.ports.follow).toBe("function");
    // The prompt builder is pipeline's own, by identity; the follower starter is supplied, so a preview can start once the flag is on.
    expect(options.previewPrompt).toBe(buildPreviewPrompt);
  });
});
