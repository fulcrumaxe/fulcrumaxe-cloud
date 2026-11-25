import { describe, expect, it, vi } from "vitest";
import type { TickSummary } from "@fx/reconcile";
import type { SetupFinishPort } from "@fx/runner-cloud";
import { reconcileNextDueAt, setupFinishStep } from "../app/api/cron/reconcile/handler";

/** D#845 ON-13a4: how the reconcile route runs one pass of the finish phase, and when it keeps the gate connecting for it. */
const CLAIM_ROW = { o_account: "a1", o_setup: "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e", o_repo: "r1", o_attempt: 1, o_owner: "acme", o_name: "widgets", o_roadmap: [{ row_key: "A1", title: "t", summary: "", size: "S", depends_on: [] }], o_seeded: [] };
const MIN = 60_000;

describe("setupFinishStep", () => {
  it("answers none when nothing is due, and builds no port for an idle tick", async () => {
    const port = vi.fn();
    const step = setupFinishStep({ reportError: vi.fn(), setupFinishPort: port as never });
    expect(await step({ query: async () => ({ rows: [] }) } as never)).toBe("none");
    expect(port).not.toHaveBeenCalled();
  });

  it("reports a claim of an impossible shape without acting on it, and goes on to the next", async () => {
    const reportError = vi.fn();
    const port = vi.fn();
    const step = setupFinishStep({ reportError, setupFinishPort: port as never });
    expect(await step({ query: async () => ({ rows: [{ ...CLAIM_ROW, o_roadmap: "nope" }] }) } as never)).toBe("done");
    expect(reportError).toHaveBeenCalledOnce();
    expect(port).not.toHaveBeenCalled();
  });

  it("runs the step over the platform_ops pool and the supplied port; an error that is not GitHub's is not swallowed", async () => {
    const queries: string[] = [];
    const pool = { query: vi.fn(async (sql: string) => { queries.push(sql); return { rows: sql.includes("setup_finish_claim") ? [CLAIM_ROW] : [{ ok: true }] }; }) };
    const boom = new Error("database down");
    const port = { discussionTarget: async () => { throw boom; } } as unknown as SetupFinishPort;
    const step = setupFinishStep({ reportError: vi.fn(), setupFinishPort: () => port });
    await expect(step(pool as never)).rejects.toBe(boom);
    expect(queries).toHaveLength(1);
  });
});

describe("reconcileNextDueAt with a finish waiting", () => {
  const NOW = 1_800_000_000_000;
  const summary: TickSummary = { enabled: true, results: [{ job: "sandbox_reap_terminal", result: "ok" }] };
  const pool = (pending: boolean, due: number) => ({
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM model_connections")) return { rows: [{ broken: false, age: null }] };
      if (sql.includes("setup_finish_pending")) return { rows: [{ pending }] };
      return { rows: ((params?.[0] ?? []) as string[]).map((name) => ({ name, due })) };
    }),
  });

  it("keeps the gate connecting at the job's own due time while a finish waits, and not otherwise", async () => {
    expect(await reconcileNextDueAt(pool(true, NOW + 9 * MIN) as never, summary, NOW)).toBe(NOW + 9 * MIN);
    expect(await reconcileNextDueAt(pool(true, NOW - 5 * MIN) as never, summary, NOW)).toBe(NOW);
    expect(await reconcileNextDueAt(pool(false, NOW + 9 * MIN) as never, summary, NOW)).toBeNull();
  });
});
