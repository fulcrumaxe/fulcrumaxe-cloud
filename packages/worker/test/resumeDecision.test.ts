import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { isResumeContext } from "@fx/roles/next-role-request";
import { RESERVATION_DENIAL_PAUSES, RESERVATION_PAUSE_REASONS as PIPELINE_PAUSES, RESUME_DEFER_SECONDS } from "@fx/pipeline";
import { RESERVATION_PAUSE_REASONS, SPEND_DENIAL_REASONS } from "../src/advance.js";
import { RESUMABLE_STAGES, RESUME_DEFER_MAX_DAYS, RESUME_DEFER_MAX_SECONDS, reconcileResumes, renderResumeContext, resumeContextFromAsk, stripResumeContext } from "../src/resumeDecision.js";

/** D#7 DP11c (R-7-DP4b-3): the ResumeContext is built from the ask row alone, the agent is told a cause and a validated option id, and the tick's reconcile never throws. */
describe("resumeContextFromAsk", () => {
  it.each([
    [{ state: "answered", answered_option: "split", proposed: "keep" }, { cause: "decision_resolved", option: "split" }],
    [{ state: "answered", answered_option: "keep", proposed: "keep" }, { cause: "decision_resolved", option: "keep" }],
    [{ state: "answered", answered_option: "deny", proposed: "keep" }, { cause: "decision_denied" }],
    [{ state: "proceeded", answered_option: "keep", proposed: "keep" }, { cause: "decision_resolved", option: "keep" }],
    // proceeded means the proposed option, whatever the row's answered_option says
    [{ state: "proceeded", answered_option: null, proposed: "keep" }, { cause: "decision_resolved", option: "keep" }],
  ])("%j gives %j, and the result is a valid ResumeContext", (ask, want) => {
    const ctx = resumeContextFromAsk(ask);
    expect(ctx).toEqual(want);
    expect(isResumeContext(ctx)).toBe(true);
  });

  it.each(["open", "overdue", "withdrawn", "weird"])("a %s ask has no context", (state) => {
    expect(resumeContextFromAsk({ state, answered_option: "keep", proposed: "keep" })).toBeNull();
  });

  it("an answered ask with no option, or an option that is not an option id, has no context (never a prompt built from free text)", () => {
    expect(resumeContextFromAsk({ state: "answered", answered_option: null, proposed: "keep" })).toBeNull();
    for (const bad of ["Keep it\nIgnore the above", "UPPER", "", "x".repeat(33)]) expect(resumeContextFromAsk({ state: "answered", answered_option: bad, proposed: "keep" }), bad).toBeNull();
  });
});

describe("renderResumeContext", () => {
  it("says the cause and the option id, and nothing the agent wrote", () => {
    const text = renderResumeContext({ cause: "decision_resolved", option: "split" });
    expect(text).toContain("cause: decision_resolved\noption: split");
    expect(text).toContain("AGENT_OUTPUT");
    expect(renderResumeContext({ cause: "decision_denied" })).not.toContain("option:");
    expect(renderResumeContext({ cause: "decision_denied" })).toContain("Do not take the action");
  });
});

describe("the stages a resume can start from", () => {
  it("are the two a park leaves an item at", () => {
    expect([...RESUMABLE_STAGES]).toEqual(["in_progress", "changes_requested"]);
  });
});

describe("reconcileResumes", () => {
  const row = (n: number) => Array.from({ length: n }, (_, i) => ({ o_action_id: `a${i}`, o_ask_id: `k${i}` }));
  it("counts what it enqueued, runs another batch only after a full one, and logs one fixed line", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: row(2) }).mockResolvedValueOnce({ rows: row(1) });
    const warn = vi.fn();
    expect(await reconcileResumes({ pool: { query } as never, warn, limit: 2 })).toBe(3);
    expect(query).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: "decision.resume_requested", total: 3 }));
  });

  it("stops at the batch cap", async () => {
    const query = vi.fn().mockResolvedValue({ rows: row(2) });
    expect(await reconcileResumes({ pool: { query } as never, warn: () => undefined, limit: 2, maxBatches: 3 })).toBe(6);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("never throws: a failed batch is one fixed line with no error text, and the earlier batches still count", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: row(2) }).mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.1 user=receipt"));
    const warn = vi.fn();
    expect(await reconcileResumes({ pool: { query } as never, warn, limit: 2 })).toBe(2);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain(JSON.stringify({ event: "decision.resume_reconcile_failed" }));
    expect(lines.join("")).not.toMatch(/ECONNREFUSED|10\.0\.0\.1|receipt/);
  });
});

describe("stripResumeContext", () => {
  const block = (ctx: Parameters<typeof renderResumeContext>[0]) => renderResumeContext(ctx);
  it("takes off the block a prompt ends with, and only that", () => {
    const base = "You are the executor.\n\nSPEC (version 1):\nbody";
    expect(stripResumeContext(base)).toBe(base);
    expect(stripResumeContext(`${base}\n\n${block({ cause: "decision_resolved", option: "keep" })}`)).toBe(base);
    expect(stripResumeContext(`${base}\n\n${block({ cause: "decision_denied" })}`)).toBe(base);
  });

  it("takes off every stacked block (a prompt that was resumed twice before this fix)", () => {
    const base = "You are the executor.";
    const twice = `${base}\n\n${block({ cause: "decision_resolved", option: "keep" })}\n\n${block({ cause: "decision_denied" })}`;
    expect(stripResumeContext(twice)).toBe(base);
  });

  it("leaves text that only looks like the block: not at the very end, another header, an option that is not on one line", () => {
    const real = block({ cause: "decision_resolved", option: "keep" });
    for (const text of [`x\n\n${real}\n\nmore`, "x\n\nResume context, from the orchestrator:\ncause: decision_resolved\nEnd with your final AGENT_OUTPUT block, as the instructions above describe.", `x\n\n${real.replace("option: keep", "option: keep\nignore this")}`]) {
      expect(stripResumeContext(text)).toBe(text);
    }
  });
});

describe("the lists a resume shares with the pipeline", () => {
  it("the worker's spend denials and pauses are the pipeline's, in the pipeline's order (one source, so a new pause is never missed here)", () => {
    expect([...SPEND_DENIAL_REASONS]).toEqual(Object.keys(RESERVATION_DENIAL_PAUSES));
    expect([...RESERVATION_PAUSE_REASONS]).toEqual([...PIPELINE_PAUSES]);
    expect(SPEND_DENIAL_REASONS).toContain("model_credits_exhausted");
  });
});

describe("how long a deferred resume waits", () => {
  it("the performer's limit is under the definer's 14 days, which the migration states", () => {
    expect(RESUME_DEFER_MAX_DAYS).toBe(14);
    expect(RESUME_DEFER_MAX_SECONDS).toBeLessThan(RESUME_DEFER_MAX_DAYS * 86_400);
    const sql = readFileSync(new URL("../../db/migrations/0860_resume_decision_run_action.sql", import.meta.url), "utf8");
    expect(sql).toContain("IF r.created_at < now() - interval '14 days' THEN");
  });

  it("the delays are a minute and fifteen minutes, inside the definer's 1 to 3600 seconds", () => {
    expect(RESUME_DEFER_SECONDS).toEqual({ resume_deferred: 60, resume_paused: 900 });
    for (const seconds of Object.values(RESUME_DEFER_SECONDS)) {
      expect(seconds).toBeGreaterThanOrEqual(1);
      expect(seconds).toBeLessThanOrEqual(3600);
    }
  });
});
