import { beforeEach, describe, expect, it, vi } from "vitest";

class FatalError extends Error {}
const calls: string[] = [];
const removal = vi.fn();
const deletion = vi.fn();
const marked = vi.fn();
let attempt = 1;
vi.mock("workflow", () => ({ sleep: async () => undefined, FatalError, getStepMetadata: () => ({ attempt }) }));
vi.mock("@fx/api/src/sse/pools.js", () => ({ appUserPool: () => ({ pool: true }) }));
vi.mock("../lib/runnerRoutes", () => ({ failRunnerLeases: async () => ({ runIds: [], complete: true }), runnerDeps: () => ({ deps: true }) }));
vi.mock("@fx/api/src/machines/projectServer.js", () => ({ removeProjectOfServer: (...a: unknown[]) => { calls.push("remove"); return removal(...a); } }));
vi.mock("@fx/api/src/machines/lifecycle.js", () => ({
  advanceServer: async () => ({ final: true, status: "ready", delaySeconds: 0 }),
  sweepOrphans: async () => ({ orphaned: 0, deleted: 0 }),
  deleteManagedServer: (...a: unknown[]) => { calls.push("delete"); return deletion(...a); },
  markDeleteFailed: (...a: unknown[]) => { calls.push("mark"); return marked(...a); },
}));

const ARGS = { accountId: "a1", userId: "u1", serverId: "s1", repoId: "r1", removalPr: true };

/** D#845 MC-12: one run removes the project's cloud parts and then deletes the server. The steps are plain functions here; the Workflow runtime is what makes them durable. */
describe("machine server delete workflow", () => {
  beforeEach(() => {
    calls.length = 0;
    removal.mockReset().mockResolvedValue(undefined);
    deletion.mockReset().mockResolvedValue({ id: "s1", status: "deleted", already_deleted: false });
    marked.mockReset().mockResolvedValue(undefined);
    attempt = 1;
  });

  it("removes the project first, then deletes the server, each with the account's own pool and the ids it was started with, and no projects asked of the delete (none are left)", async () => {
    const { machineServerDeleteWorkflow } = await import("./machineServers");
    expect(await machineServerDeleteWorkflow(ARGS)).toBe("deleted");
    expect(calls).toEqual(["remove", "delete"]);
    expect(removal).toHaveBeenCalledWith({ pool: { pool: true }, principal: { accountId: "a1", userId: "u1" } }, { deps: true }, ARGS);
    expect(deletion).toHaveBeenCalledWith({ pool: { pool: true }, principal: { accountId: "a1", userId: "u1" } }, "s1", { removeProjects: false, fromRun: true });
  });

  it("a refusal (a 4xx) ends the run without a retry and without deleting the server; the removal's own words are the reason", async () => {
    const { ApiError } = await import("@fx/api/src/errors.js");
    const { machineServerDeleteWorkflow } = await import("./machineServers");
    removal.mockRejectedValue(new ApiError(409, "project_not_on_server", "x"));
    await expect(machineServerDeleteWorkflow(ARGS)).rejects.toBeInstanceOf(FatalError);
    await expect(machineServerDeleteWorkflow(ARGS)).rejects.toMatchObject({ message: "project_not_on_server" });
    expect(calls).not.toContain("delete");
    // The refusal is written on the row first, with its own code, so the Servers tab shows why.
    expect(marked).toHaveBeenCalledWith({ pool: { pool: true }, principal: { accountId: "a1", userId: "u1" } }, "s1", "project_not_on_server");
    expect(calls.slice(0, 2)).toEqual(["remove", "mark"]);
  });

  it("a delete that is refused ends the run; Hetzner or the database being down (a 5xx or any other error) is left to the Workflow to retry; a rate limit is retried too", async () => {
    const { ApiError } = await import("@fx/api/src/errors.js");
    const { deleteServerStep } = await import("./machineServers");
    deletion.mockRejectedValue(new ApiError(409, "credential_changed", "x"));
    await expect(deleteServerStep(ARGS)).rejects.toBeInstanceOf(FatalError);
    for (const retryable of [new ApiError(503, "hetzner_unavailable", "x"), new ApiError(429, "hetzner_rate_limit_exceeded", "x"), new Error("connection reset")]) {
      deletion.mockRejectedValue(retryable);
      const err = await deleteServerStep(ARGS).catch((e: unknown) => e);
      expect(err).toBe(retryable);
      expect(err).not.toBeInstanceOf(FatalError);
    }
  });

  it("the first step failing for a retryable reason is thrown as it is, so the Workflow tries it again; nothing is written on the row and the server is not deleted meanwhile", async () => {
    const { machineServerDeleteWorkflow } = await import("./machineServers");
    const down = new Error("database down");
    removal.mockRejectedValue(down);
    await expect(machineServerDeleteWorkflow(ARGS)).rejects.toBe(down);
    expect(calls).toEqual(["remove"]);
  });

  it("on the last try a retryable failure is written on the row as delete_failed before it is thrown; one try earlier it is not", async () => {
    const { deleteServerStep, removeProjectStep } = await import("./machineServers");
    const down = new Error("hetzner down");
    deletion.mockRejectedValue(down);
    attempt = 3;
    await expect(deleteServerStep(ARGS)).rejects.toBe(down);
    expect(marked).not.toHaveBeenCalled();
    attempt = 4;
    await expect(deleteServerStep(ARGS)).rejects.toBe(down);
    expect(marked).toHaveBeenCalledWith({ pool: { pool: true }, principal: { accountId: "a1", userId: "u1" } }, "s1", "delete_failed");
    marked.mockClear();
    removal.mockRejectedValue(down);
    await expect(removeProjectStep(ARGS)).rejects.toBe(down);
    expect(marked).toHaveBeenCalledWith(expect.anything(), "s1", "delete_failed");
  });

  it("a delete refused after the runner was revoked (Hetzner refusing the token) writes that code on the row, and the run ends without a retry", async () => {
    const { ApiError } = await import("@fx/api/src/errors.js");
    const { machineServerDeleteWorkflow } = await import("./machineServers");
    deletion.mockRejectedValue(new ApiError(409, "hetzner_unauthorized", "x"));
    await expect(machineServerDeleteWorkflow(ARGS)).rejects.toBeInstanceOf(FatalError);
    expect(marked).toHaveBeenCalledWith(expect.anything(), "s1", "hetzner_unauthorized");
    expect(calls).toEqual(["remove", "delete", "mark"]);
  });
});
