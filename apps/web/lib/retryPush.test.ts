import { describe, expect, it, vi } from "vitest";

vi.mock("workflow/api", () => ({ start: vi.fn() }));
const worker = { retryPublish: vi.fn(), openPublicPullRequest: vi.fn() };
vi.mock("./worker", () => ({ getWorker: vi.fn(async () => worker) }));

import { createStartRetryPush, openPublicPullRequestViaWorker } from "./retryPush";
import { retryPushStep, retryPushWorkflow } from "../workflows/retryPush";
import { getWorker } from "./worker";

describe("createStartRetryPush (D#598 P1f-6b)", () => {
  it("starts the workflow with plain ids only (the user id stays out of it) and resolves once the start is accepted", async () => {
    const start = vi.fn(async () => ({ runId: "wf-1" }));
    await expect(createStartRetryPush({ start })({ accountId: "a", userId: "u", workItemId: "w" })).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledWith(retryPushWorkflow, [{ accountId: "a", workItemId: "w" }]);
  });

  it("a Workflow outage rejects, so the route answers 503 and no attempt was made", async () => {
    const start = vi.fn(async () => {
      throw new Error("workflow service down");
    });
    await expect(createStartRetryPush({ start })({ accountId: "a", userId: "u", workItemId: "w" })).rejects.toThrow("workflow service down");
  });
});

describe("the workflow's one step", () => {
  it("calls the worker's retryPublish once and returns only a fixed kind and code", async () => {
    worker.retryPublish.mockResolvedValueOnce({ kind: "refused", code: "pairing_off", attemptNo: null });
    expect(await retryPushStep("a", "w")).toEqual({ kind: "refused", code: "pairing_off" });
    expect(worker.retryPublish).toHaveBeenCalledWith({ accountId: "a", workItemId: "w" });
    worker.retryPublish.mockResolvedValueOnce({ kind: "published", state: "pr_opened", attemptNo: 2 });
    expect(await retryPushStep("a", "w")).toEqual({ kind: "published", code: null });
  });

  it("with no worker configured it does nothing", async () => {
    vi.mocked(getWorker).mockResolvedValueOnce(null);
    expect(await retryPushStep("a", "w")).toEqual({ kind: "not_configured", code: null });
  });
});

describe("openPublicPullRequestViaWorker", () => {
  it("passes the worker's answer through as the route's closed shapes", async () => {
    worker.openPublicPullRequest.mockResolvedValueOnce({ kind: "opened", prNumber: 9, attemptNo: 1 });
    expect(await openPublicPullRequestViaWorker({ accountId: "a", workItemId: "w" })).toEqual({ kind: "opened", prNumber: 9 });
    worker.openPublicPullRequest.mockResolvedValueOnce({ kind: "refused", code: "pr_failed", attemptNo: 1 });
    expect(await openPublicPullRequestViaWorker({ accountId: "a", workItemId: "w" })).toEqual({ kind: "refused", code: "pr_failed" });
    worker.openPublicPullRequest.mockResolvedValueOnce({ kind: "skipped", why: "not_retryable" });
    expect(await openPublicPullRequestViaWorker({ accountId: "a", workItemId: "w" })).toEqual({ kind: "skipped" });
    vi.mocked(getWorker).mockResolvedValueOnce(null);
    expect(await openPublicPullRequestViaWorker({ accountId: "a", workItemId: "w" })).toEqual({ kind: "not_configured" });
  });
});
