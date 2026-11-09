import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { ReaderFaultRefusedError } from "@fx/runner";
import { buildWorker, type BuildWorkerOptions, type WorkerPorts } from "../src/compositionRoot.js";
import type { WorkerPools } from "../src/pools.js";

const FORWARD_ENV = { FX_GH_FORWARD_SUFFIX: "fixture.test", FX_GH_FORWARD_HOST: "gh-proxy.fixture.test" };
const ports: WorkerPorts = {
  decryptTenantKey: async () => "fake-key",
  modelConnection: { get: async () => { throw new Error("not used"); } },
  connectionStatus: { markBroken: async () => {}, markCreditsExhausted: async () => {} },
  hooks: { resume: async () => {} },
};

function build(env: Record<string, string | undefined>, opened: { n: number }): Promise<unknown> {
  const options: BuildWorkerOptions = {
    env: { ...FORWARD_ENV, ...env },
    vercel: { teamId: "t", projectId: "p", getToken: async () => "tok" },
    ports,
    createPools: async () => {
      opened.n++;
      return { runnerPool: {} as Pool, platformOpsPool: {} as Pool, receiptPool: {} as Pool, async close() {} } satisfies WorkerPools;
    },
  };
  return buildWorker(options);
}

describe("the run-log reader's staging fault flags at startup", () => {
  it.each([
    ["production", { FX_DEPLOY_KIND: "production" }],
    ["a deployment with no kind", {}],
  ])("%s: FX_READER_CRASH and FX_RECORDER_TAMPER stop the worker before any pool opens", async (_n, kind) => {
    for (const flag of [{ FX_READER_CRASH: "2" }, { FX_RECORDER_TAMPER: "1" }]) {
      const opened = { n: 0 };
      await expect(build({ ...kind, ...flag, FX_READER_SLICE_MS: "300000" }, opened)).rejects.toThrow(ReaderFaultRefusedError);
      expect(opened.n).toBe(0);
    }
  });

  it("a Vercel production deployment whose kind reads staging is refused unless it says it is staging", async () => {
    const opened = { n: 0 };
    await expect(build({ FX_DEPLOY_KIND: "staging", VERCEL_ENV: "production", FX_READER_CRASH: "2" }, opened)).rejects.toThrow(ReaderFaultRefusedError);
    await expect(build({ FX_DEPLOY_KIND: "staging", VERCEL_ENV: "production", FX_DEPLOY_ENV: "production", FX_RECORDER_TAMPER: "1" }, opened)).rejects.toThrow(ReaderFaultRefusedError);
    expect(opened.n).toBe(0);
    await expect(build({ FX_DEPLOY_KIND: "staging", VERCEL_ENV: "production", FX_DEPLOY_ENV: "staging", FX_READER_CRASH: "2" }, { n: 0 })).resolves.toBeDefined();
  });

  it("staging builds with them, and a production worker builds without them", async () => {
    await expect(build({ FX_DEPLOY_KIND: "staging", FX_READER_SLICE_MS: "300000", FX_READER_CRASH: "2", FX_RECORDER_TAMPER: "1" }, { n: 0 })).resolves.toBeDefined();
    await expect(build({ FX_DEPLOY_KIND: "production", FX_READER_SLICE_MS: "300000" }, { n: 0 })).resolves.toBeDefined();
  });
});
