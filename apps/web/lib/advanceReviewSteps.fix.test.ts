import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { startFixBody, startReviewerBody, type ReviewCtx } from "./advanceReviewSteps";

/** D#600 CX-2: the fix round sends the unchanged-Spec line only where the session is certainly the one that built, and every start carries the section list. */
const WHO = { accountId: "a", userId: "u", workItemId: "w", haltEpoch: 0 };
const HEAD = "b".repeat(40);
const SPEC = "Acceptance: the footer shows the year.";
const SHA = createHash("sha256").update(SPEC).digest("hex");
const PR = { number: 41, headSha: HEAD, branch: "fx/issue-7", baseRef: "main" };

function fixture(executionMode: string) {
  const started = vi.fn(async (..._args: unknown[]) => ({ ok: true as const, runId: "r1" }));
  const worker = {
    advanceLoadSpecText: async () => ({ version: 3, body: SPEC, sha256: SHA }),
    advanceRunOutcome: async () => ({ status: "succeeded", done: true, envelope: { verdict: "needs-fix", findings: ["a.ts:1 - bad"], summary: "s" } }),
    advanceStartFix: started,
    advanceStartRun: started,
    advanceRecordEvent: async () => undefined,
  };
  const ctx = { repoId: "r", owner: "acme", name: "widgets", issue: 7, tier: "t", specVersion: 3, debaterEnabled: false, executionMode } as unknown as ReviewCtx;
  return { worker: worker as never, ctx, started };
}

describe("startFixBody: the Spec in a fix round", () => {
  it("a sandbox round resumes the build's session, so it sends the unchanged line with the stored hash and not the body", async () => {
    const f = fixture("sandbox");
    expect(await startFixBody(f.worker, WHO, f.ctx, PR, "act", 1, [{ role: "code-reviewer", runId: "x" }])).toMatchObject({ ok: true });
    const req = f.started.mock.calls[0]!.at(-1) as { prompt: string; contextSections: Array<{ code: string }> };
    expect(req.prompt).toContain(`Spec v3 unchanged (sha256 ${SHA})`);
    expect(req.prompt).not.toContain(SPEC);
    expect(req.contextSections.map((s) => s.code)).toEqual(["boundary", "spec", "findings", "output"]);
  });

  it("a sandbox round also sends the held version and the body-carrying prompt, for the fresh session a lost snapshot starts and for the worker's pin check", async () => {
    const f = fixture("sandbox");
    await startFixBody(f.worker, WHO, f.ctx, PR, "act", 1, [{ role: "code-reviewer", runId: "x" }]);
    const req = f.started.mock.calls[0]!.at(-1) as { held: unknown; fallbackPrompt: string; fallbackContextSections: Array<{ code: string }> };
    expect(req.held).toEqual({ version: 3, sha256: SHA });
    expect(req.fallbackPrompt).toContain(SPEC);
    expect(req.fallbackPrompt).toContain("SPEC (version 3):");
    expect(req.fallbackPrompt).not.toContain("unchanged (sha256");
    expect(req.fallbackContextSections.map((s) => s.code)).toEqual(["boundary", "spec", "findings", "output"]);
  });

  it("D#600 CX-10a: a fix prompt records its assembly time alone (whole milliseconds), with no cold flag", async () => {
    const f = fixture("sandbox");
    await startFixBody(f.worker, WHO, f.ctx, PR, "act", 1, [{ role: "code-reviewer", runId: "x" }]);
    const req = f.started.mock.calls[0]!.at(-1) as { contextAssembly: Record<string, unknown> };
    expect(Object.keys(req.contextAssembly)).toEqual(["ms"]);
    expect(Number.isInteger(req.contextAssembly.ms)).toBe(true);
  });

  it("a runner round may be a follow-up in a fresh session, so it keeps the Spec body", async () => {
    const f = fixture("runner_local");
    await startFixBody(f.worker, WHO, f.ctx, PR, "act", 1, [{ role: "code-reviewer", runId: "x" }]);
    const req = f.started.mock.calls[0]!.at(-1) as { prompt: string };
    expect(req.prompt).toContain(SPEC);
    expect(req.prompt).not.toContain("unchanged (sha256");
    expect(req).not.toHaveProperty("held");
    expect(req).not.toHaveProperty("fallbackPrompt");
  });

  it("a worker that reports no hash sends the body", async () => {
    const f = fixture("sandbox");
    (f.worker as unknown as { advanceLoadSpecText: () => Promise<unknown> }).advanceLoadSpecText = async () => ({ version: 3, body: SPEC });
    await startFixBody(f.worker, WHO, f.ctx, PR, "act", 1, [{ role: "code-reviewer", runId: "x" }]);
    expect((f.started.mock.calls[0]!.at(-1) as { prompt: string }).prompt).toContain(SPEC);
  });
});

describe("startReviewerBody", () => {
  it("passes the review prompt's section list on the run request", async () => {
    const f = fixture("sandbox");
    await startReviewerBody(f.worker, WHO, f.ctx, PR, "code-reviewer", [], 0);
    const req = f.started.mock.calls[0]!.at(-1) as { contextSections: Array<{ code: string; bytes: number }> };
    expect(req.contextSections.map((s) => s.code)).toEqual(["boundary", "spec", "output"]);
    expect(req.contextSections.every((s) => s.bytes > 0)).toBe(true);
  });

  it("D#600 CX-10a: a review prompt records its assembly time alone (whole milliseconds), with no cold flag", async () => {
    const f = fixture("sandbox");
    await startReviewerBody(f.worker, WHO, f.ctx, PR, "code-reviewer", [], 0);
    const req = f.started.mock.calls[0]!.at(-1) as { contextAssembly: Record<string, unknown> };
    expect(Object.keys(req.contextAssembly)).toEqual(["ms"]);
    expect(Number.isInteger(req.contextAssembly.ms)).toBe(true);
    expect(req.contextAssembly.ms as number).toBeGreaterThanOrEqual(0);
  });

  it("D#598 P7a: the security reviewer's prompt gets the step-back once two fix rounds have started, for any repository", async () => {
    const promptFor = async (fixRoundsStarted: number | undefined): Promise<string> => {
      const f = fixture("sandbox");
      await startReviewerBody(f.worker, WHO, { ...f.ctx, ...(fixRoundsStarted === undefined ? {} : { fixRoundsStarted }) }, PR, "security-reviewer", [], 0);
      return (f.started.mock.calls[0]!.at(-1) as { prompt: string }).prompt;
    };
    for (const n of [undefined, 0, 1]) {
      const p = await promptFor(n);
      expect(p).toMatch(/write the threat model/);
      expect(p).not.toMatch(/Step back: check whether/);
    }
    for (const n of [2, 3]) expect(await promptFor(n)).toMatch(/Step back: check whether/);
  });
});
