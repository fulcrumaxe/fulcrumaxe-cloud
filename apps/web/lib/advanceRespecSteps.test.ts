import { describe, expect, it, vi } from "vitest";
import { publishRespecBody, startRespecBody } from "./advanceRespecSteps";

/** D#6 R4d-5b: the Re-spec steps' bodies over a fake worker. */
const WHO = { accountId: "a", userId: "u", workItemId: "w", haltEpoch: 3 };

describe("startRespecBody", () => {
  it("starts the project manager in file-list mode on the Spec version the press saw: keyed per press, on a checkout, under the workflow's halt epoch", async () => {
    const start = vi.fn(async (_req: unknown) => ({ ok: true as const, runId: "r" }));
    const load = vi.fn(async () => ({ version: 2, body: "THE SPEC TEXT" }));
    const out = await startRespecBody({ advanceStartRun: start, advanceLoadSpecText: load } as never, WHO, 2, "act-1");
    expect(out).toEqual({ ok: true, runId: "r" });
    expect(load).toHaveBeenCalledWith(WHO, 2);
    const req = start.mock.calls[0]![0] as { step: string; role: string; clone: boolean; haltEpoch: number; prompt: string };
    expect(req).toMatchObject({ step: "respec:act-1", role: "project-manager", clone: true, haltEpoch: 3 });
    expect(req.prompt).toContain("Also give `acceptance_files`");
    expect(req.prompt).toContain("THE SPEC TEXT");
    expect(req.prompt).toContain("SPEC (version 2):");
  });

  it("starts nothing when the Spec moved on or there is none: spec_changed, no_spec, worker_unavailable", async () => {
    const start = vi.fn();
    expect(await startRespecBody({ advanceStartRun: start, advanceLoadSpecText: async () => null } as never, WHO, 2, "a")).toEqual({ ok: false, reason: "spec_changed" });
    expect(await startRespecBody({ advanceStartRun: start, advanceLoadSpecText: async () => null } as never, WHO, null, "a")).toEqual({ ok: false, reason: "no_spec" });
    expect(await startRespecBody(null, WHO, 2, "a")).toEqual({ ok: false, reason: "worker_unavailable" });
    expect(start).not.toHaveBeenCalled();
  });
});

describe("publishRespecBody", () => {
  it("hands the run, the press and the version to the worker and returns its answer", async () => {
    const advanceRespec = vi.fn(async () => ({ status: "published", reason: null, version: 3 }));
    expect(await publishRespecBody({ advanceRespec } as never, WHO, "run", "act", 2)).toEqual({ status: "published", reason: null, version: 3 });
    expect(advanceRespec).toHaveBeenCalledWith(WHO, "run", "act", 2);
    expect(await publishRespecBody(null, WHO, "run", "act", 2)).toEqual({ status: "refused", reason: "worker_unavailable", version: null });
  });
});
