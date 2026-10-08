import { describe, expect, it, vi } from "vitest";

vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("./worker", () => ({ getWorker: vi.fn(async () => null) }));

import { createStartAdvance } from "./advance";
import { workItemAdvanceWorkflow } from "../workflows/workItemAdvance";

describe("createStartAdvance", () => {
  it("starts the advance workflow with the plain-data arguments and resolves once the start is accepted", async () => {
    const start = vi.fn(async () => ({ runId: "wf-1" }));
    const args = { accountId: "a", userId: "u", workItemId: "w", actionId: "x", haltEpoch: 0 };
    await expect(createStartAdvance({ start })(args)).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledWith(workItemAdvanceWorkflow, [args]);
  });

  it("a Workflow outage rejects, so the run action stays accepted and is retried with backoff", async () => {
    const start = vi.fn(async () => {
      throw new Error("workflow service down");
    });
    await expect(createStartAdvance({ start })({ accountId: "a", userId: "u", workItemId: "w", actionId: "x", haltEpoch: 0 })).rejects.toThrow("workflow service down");
  });
});
