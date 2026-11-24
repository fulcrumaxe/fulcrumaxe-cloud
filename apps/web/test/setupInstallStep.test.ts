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
