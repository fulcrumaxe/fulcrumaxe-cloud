import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("workflow", () => ({ sleep: async () => undefined }));
vi.mock("@fx/api/src/sse/pools.js", () => ({ appUserPool: () => ({}) }));
vi.mock("../lib/runnerRoutes", () => ({ failRunnerLeases: async () => ({ runIds: [], complete: true }) }));

/** D#845 MC-7: the Workflow steps run outside the /api/v1 route, so they install the lease-fail port the sweep's runner revoke needs. */
describe("machine server workflow ports", () => {
  afterEach(async () => {
    const { machineServerDeps } = await import("@fx/api/src/machines/servers.js");
    delete machineServerDeps.failRunnerLeases;
  });

  it("installs the lease-fail port when a step starts, and keeps one that is already set", async () => {
    const { machineServerDeps } = await import("@fx/api/src/machines/servers.js");
    const { wireMachineServerPorts } = await import("../lib/machineServerPorts");
    delete machineServerDeps.failRunnerLeases;
    wireMachineServerPorts();
    expect(typeof machineServerDeps.failRunnerLeases).toBe("function");
    const mine = async () => ({ runIds: [], complete: true });
    machineServerDeps.failRunnerLeases = mine;
    wireMachineServerPorts();
    expect(machineServerDeps.failRunnerLeases).toBe(mine);
  });
});
