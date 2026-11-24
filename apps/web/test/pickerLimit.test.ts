import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { RunnerCloudDeps } from "@fx/runner-cloud";
import { RateLimitedError } from "@fx/api/src/errors.js";
import { pickerRun } from "../app/api/runners/repos/picker/handler";

/** D#845 FU-240: the picker read is charged to the account first; a refused read touches neither the database nor GitHub. No network, no database. */
const deps = { appUserPool: { tag: "pool" } as unknown as Pool } as unknown as RunnerCloudDeps;
const principal = { accountId: "00000000-0000-4000-8000-0000000000a1", userId: "00000000-0000-4000-8000-0000000000b1" };
const ok = { status: 200, body: { repos: [] } };

describe("GET /api/runners/repos/picker limit", () => {
  it("charges the caller's account and user, then reads", async () => {
    const limit = vi.fn(async () => undefined);
    const read = vi.fn(async () => ok);
    expect(await pickerRun(limit, read)(deps, principal)).toBe(ok);
    expect(limit).toHaveBeenCalledWith(deps.appUserPool, principal);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("over the cap: 429 rate_limited with retry_after and the header, and nothing is read", async () => {
    const limit = vi.fn(async () => {
      throw new RateLimitedError(41.2);
    });
    const read = vi.fn(async () => ok);
    const res = await pickerRun(limit, read)(deps, principal);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: { code: "rate_limited" }, retry_after: 42 });
    expect(res.headers).toEqual({ "retry-after": "42" });
    expect(read).not.toHaveBeenCalled();
  });

  it("a limiter that cannot run is an error, never an unlimited read", async () => {
    const limit = vi.fn(async () => {
      throw new Error("store down");
    });
    const read = vi.fn(async () => ok);
    await expect(pickerRun(limit, read)(deps, principal)).rejects.toThrow("store down");
    expect(read).not.toHaveBeenCalled();
  });
});
