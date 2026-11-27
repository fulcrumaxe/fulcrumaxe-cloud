import { describe, expect, it, vi } from "vitest";
import type { TickSummary } from "@fx/reconcile";
import type { SetupInstallPort } from "@fx/runner-cloud";
import { reconcileNextDueAt, setupInstallStep } from "../app/api/cron/reconcile/handler";

/** D#845 ON-8f2a: how the reconcile route runs one pass of the install pull request step, and when it keeps the gate connecting for it. */
const SHA = "c".repeat(40);
const CLAIM_ROW = { o_account: "a1", o_setup: "s1", o_repo: "r1", o_user: "u1", o_attempt: 1, o_mode: "pr", o_base: "a".repeat(40), o_branch: "fx/engine-install-1.2.3", o_head: SHA, o_version: "1.2.3", o_owner: "acme", o_name: "widgets" };
const MIN = 60_000;

describe("setupInstallStep", () => {
  it("answers none when nothing is due, and builds no port for an idle tick", async () => {
    const port = vi.fn();
    const step = setupInstallStep({ reportError: vi.fn(), setupInstallPort: port as never });
    expect(await step({ query: async () => ({ rows: [] }) } as never)).toBe("none");
    expect(port).not.toHaveBeenCalled();
  });

  it("reports a claim of an impossible shape without acting on it, and goes on to the next", async () => {
    const reportError = vi.fn();
    const port = vi.fn();
    const step = setupInstallStep({ reportError, setupInstallPort: port as never });
    expect(await step({ query: async () => ({ rows: [{ ...CLAIM_ROW, o_branch: "main" }] }) } as never)).toBe("done");
    expect(reportError).toHaveBeenCalledOnce();
    expect(port).not.toHaveBeenCalled();
  });

  it("runs the step over the platform_ops pool and the supplied port; an error that is not GitHub's is not swallowed", async () => {
    const queries: string[] = [];
    const pool = { query: vi.fn(async (sql: string) => { queries.push(sql); return { rows: sql.includes("setup_install_pr_claim") ? [CLAIM_ROW] : [{ ok: true }] }; }) };
    const boom = new Error("database down");
    const port = { defaultBranch: async () => { throw boom; } } as unknown as SetupInstallPort;
    const step = setupInstallStep({ reportError: vi.fn(), setupInstallPort: () => port });
    await expect(step(pool as never)).rejects.toBe(boom);
    expect(queries).toHaveLength(1);
  });
});

describe("reconcileNextDueAt with a pushed install waiting", () => {
  const NOW = 1_800_000_000_000;
  const summary: TickSummary = { enabled: true, results: [{ job: "sandbox_reap_terminal", result: "ok" }] };
  const pool = (pending: boolean, due: number) => ({
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM model_connections")) return { rows: [{ broken: false, age: null }] };
      if (sql.includes("setup_install_pr_pending")) return { rows: [{ pending }] };
      return { rows: ((params?.[0] ?? []) as string[]).map((name) => ({ name, due })) };
    }),
  });

  it("keeps the gate connecting at the job's own due time while a setup waits, and not otherwise", async () => {
    expect(await reconcileNextDueAt(pool(true, NOW + 9 * MIN) as never, summary, NOW)).toBe(NOW + 9 * MIN);
    expect(await reconcileNextDueAt(pool(true, NOW - 5 * MIN) as never, summary, NOW)).toBe(NOW);
    expect(await reconcileNextDueAt(pool(false, NOW + 9 * MIN) as never, summary, NOW)).toBeNull();
  });
});

// D#845 Ruling 122: a 15-minute job that answered not_due (or stopped on its budget) carries its next_due_at to the gate, so the gate never falls back to the slow backstop while the job still has a due time.
describe("reconcileNextDueAt carries a not_due 15-minute job", () => {
  const NOW = 1_800_000_000_000;
  const summaryOf = (job: string, result: "not_due" | "budget" | "ok"): TickSummary => ({ enabled: true, results: [{ job: "sandbox_reap_terminal", result: "ok" }, { job, result }] });
  const pool = (due: number, probe: "false" | "throws") => ({
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM model_connections")) return { rows: [{ broken: false, age: null }] };
      if (sql.includes("setup_install_pr_pending") || sql.includes("setup_finish_pending")) {
        if (probe === "throws") throw new Error("read failed");
        return { rows: [{ pending: false }] };
      }
      return { rows: ((params?.[0] ?? []) as string[]).map((name) => ({ name, due })) };
    }),
  });

  it.each(["setup_install_pr", "setup_finish"])("%s: not_due or budget reconnects the gate at the job's own due time, even when the probe sees no work or cannot read", async (job) => {
    for (const probe of ["false", "throws"] as const) {
      for (const result of ["not_due", "budget"] as const) {
        expect(await reconcileNextDueAt(pool(NOW + 7 * MIN, probe) as never, summaryOf(job, result), NOW), `${probe} ${result}`).toBe(NOW + 7 * MIN);
      }
    }
    // never earlier than now
    expect(await reconcileNextDueAt(pool(NOW - 3 * MIN, "false") as never, summaryOf(job, "not_due"), NOW)).toBe(NOW);
  });

  it.each(["setup_install_pr", "setup_finish"])("%s: a job that ran (ok) with nothing pending leaves the gate free to sleep", async (job) => {
    expect(await reconcileNextDueAt(pool(NOW + 7 * MIN, "false") as never, summaryOf(job, "ok"), NOW)).toBeNull();
  });
});
