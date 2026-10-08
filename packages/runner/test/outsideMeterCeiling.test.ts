import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

const limits = vi.hoisted(() => ({ value: { per_run_usd: 1, max_resumes: 0 } as { per_run_usd: number; max_resumes: number } }));
vi.mock("@fx/core/src/run-limits/resolve.js", () => ({ resolveRunLimits: async () => limits.value }));

import { trueUpCeilingUsd } from "../src/outsideMeterSweep.js";

/** A pool whose one client answers every statement with the run's role; the limits themselves come from the mocked resolver above. */
const pool = {
  connect: async () => ({ query: async () => ({ rows: [{ role: "executor" }] }), release: () => undefined }),
} as unknown as Pool;
const run = { account_id: "00000000-0000-4000-8000-000000000001", run_id: "00000000-0000-4000-8000-000000000002" };
const ceiling = (l: { per_run_usd: number; max_resumes: number }) => { limits.value = l; return trueUpCeilingUsd(pool, run); };

describe("trueUpCeilingUsd limits that are not usable numbers", () => {
  it("NaN or Infinity in either limit gives the fixed floor of 5, never NaN, Infinity or a number a true-up could pass", async () => {
    expect(await ceiling({ per_run_usd: Number.NaN, max_resumes: 0 })).toBe(5);
    expect(await ceiling({ per_run_usd: Number.POSITIVE_INFINITY, max_resumes: 0 })).toBe(5);
    expect(await ceiling({ per_run_usd: 3, max_resumes: Number.NaN })).toBe(5);
    expect(await ceiling({ per_run_usd: 3, max_resumes: Number.POSITIVE_INFINITY })).toBe(5);
  });
  it("usable limits still give twice the cap per spawn, never under 5", async () => {
    expect(await ceiling({ per_run_usd: 1, max_resumes: 0 })).toBe(5);
    expect(await ceiling({ per_run_usd: 10, max_resumes: 0 })).toBe(20);
    expect(await ceiling({ per_run_usd: 10, max_resumes: 2 })).toBe(60);
  });
});
