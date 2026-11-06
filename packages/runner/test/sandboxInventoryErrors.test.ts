import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { SandboxInventoryError, inventoryListFailureCode, sandboxInventory } from "../src/sandboxReap.js";
import { createVercelSandboxPort } from "../src/vercelSandboxPort.js";
import type { SandboxPort } from "../src/sandboxPort.js";
import { createReaperSdkFake } from "./helpers/reaperSdkFake.js";

/** D#6: every real failure class of the daily inventory reports under its own code, and a normal answer (empty, paged) still writes. */
const EX = (n: number) => `ex-11111111-1111-4111-8111-111111111111-22222222-2222-4222-8222-222222222222-${n}`;

function poolStub(opts: { fail?: boolean } = {}) {
  const calls: unknown[][] = [];
  const pool = {
    query: async (_sql: string, params: unknown[]) => {
      calls.push(params);
      if (opts.fail) throw Object.assign(new Error("permission denied for function sandbox_inventory_write"), { code: "42501" });
      return { rows: [{ accounts: 0, orphans: 0, over_cap: 0 }] };
    },
  } as unknown as Pool;
  return { pool, calls };
}

async function failure(port: SandboxPort, pool: Pool): Promise<{ error: SandboxInventoryError; lines: string[] }> {
  const lines: string[] = [];
  const error = await sandboxInventory({ pool, port, log: (l) => void lines.push(l) }, { now: 1 }).then(
    () => {
      throw new Error("the inventory should have failed");
    },
    (e: unknown) => e as SandboxInventoryError,
  );
  return { error, lines };
}

const realPort = (fake: ReturnType<typeof createReaperSdkFake>, getToken: () => Promise<string> = async () => "tok") =>
  createVercelSandboxPort({ teamId: "t", projectId: "p", getToken, sdk: fake.sdk });

describe("the inventory names each provider failure class", () => {
  const cases: [number, string, string][] = [
    [401, "sandbox_inventory_denied", "4xx"],
    [403, "sandbox_inventory_denied", "4xx"],
    [404, "sandbox_inventory_not_found", "4xx"],
    [410, "sandbox_inventory_not_found", "4xx"],
    [429, "sandbox_inventory_rate_limited", "4xx"],
    [400, "sandbox_inventory_rejected", "4xx"],
    [500, "sandbox_inventory_provider_error", "5xx"],
    [503, "sandbox_inventory_provider_error", "5xx"],
  ];
  for (const [status, code, statusClass] of cases) {
    it(`status ${status} is ${code}`, async () => {
      const fake = createReaperSdkFake();
      fake.failNext("list", status);
      const { pool, calls } = poolStub();
      const { error, lines } = await failure(realPort(fake), pool);
      expect(error).toBeInstanceOf(SandboxInventoryError);
      expect(error.code).toBe(code);
      expect(JSON.parse(lines[0]!)).toMatchObject({ event: "sandbox_inventory.failed", step: "list", prefix: "ex-", operation: "listSandboxes", status_class: statusClass, code });
      expect(calls).toEqual([]); // nothing written: the previous inventory stands
    });
  }

  it("a token that cannot be fetched is sandbox_inventory_credentials", async () => {
    const { error } = await failure(realPort(createReaperSdkFake(), async () => { throw new Error("no token"); }), poolStub().pool);
    expect(error.code).toBe("sandbox_inventory_credentials");
  });

  it("a list that fails with no status is sandbox_inventory_no_answer", async () => {
    const fake = createReaperSdkFake();
    fake.sdk.list = async () => { throw new Error("socket hang up"); };
    const { error, lines } = await failure(realPort(fake), poolStub().pool);
    expect(error.code).toBe("sandbox_inventory_no_answer");
    expect(JSON.parse(lines[0]!)).toMatchObject({ status_class: "none" });
  });

  it("an answer without a sandboxes array is sandbox_inventory_bad_answer", async () => {
    const port = { listSandboxes: async () => ({ next: null }) } as unknown as SandboxPort;
    const { error, lines } = await failure(port, poolStub().pool);
    expect(error.code).toBe("sandbox_inventory_bad_answer");
    expect(JSON.parse(lines[0]!)).toMatchObject({ operation: "shape" });
  });

  it("a refused database write is sandbox_inventory_write_failed, without the database's message in the log", async () => {
    const { error, lines } = await failure(realPort(createReaperSdkFake()), poolStub({ fail: true }).pool);
    expect(error.code).toBe("sandbox_inventory_write_failed");
    expect(lines.join("\n")).not.toContain("permission denied");
  });

  it("the classifier gives a non-port error the bad-answer code", () => {
    expect(inventoryListFailureCode(new TypeError("x"))).toBe("sandbox_inventory_bad_answer");
  });
});

describe("a normal answer still writes", () => {
  it("an empty project writes an empty inventory", async () => {
    const { pool, calls } = poolStub();
    const result = await sandboxInventory({ pool, port: realPort(createReaperSdkFake()), log: () => undefined }, { now: 1 });
    expect(calls).toEqual([[[], [], 20]]);
    expect(result).toMatchObject({ live: 0, accounts: 0, alerts: [] });
  });

  it("a paged list is read to the end", async () => {
    const fake = createReaperSdkFake();
    fake.pageLimit = 2;
    for (const n of [1, 2, 3, 4, 5]) fake.seed(EX(n), "running");
    const { pool, calls } = poolStub();
    const result = await sandboxInventory({ pool, port: realPort(fake), log: () => undefined }, { now: 1 });
    expect(result.live).toBe(5);
    expect((calls[0]![0] as string[]).length).toBe(5);
  });
});

describe("the inventory keeps to the job's call budget", () => {
  const seedMany = (fake: ReturnType<typeof createReaperSdkFake>, n: number): void => {
    fake.pageLimit = 1;
    for (let i = 1; i <= n; i++) fake.seed(EX(i), "running");
  };

  it("stops at the budget, writes nothing, and reports a coded partial result", async () => {
    const fake = createReaperSdkFake();
    seedMany(fake, 10); // 10 pages for ex-, then one each for rn- and pp-
    const { pool, calls } = poolStub();
    const lines: string[] = [];
    const result = await sandboxInventory({ pool, port: realPort(fake), log: (l) => void lines.push(l) }, { now: 1, maxCalls: 4 });
    expect(fake.listQueries.length).toBe(4);
    expect(result.callsUsed).toBe(4);
    expect(result.alerts).toContain("sandbox_inventory_budget_exhausted");
    expect(calls).toEqual([]); // the previous inventory rows stand
    expect(result.accounts).toBe(0);
    expect(lines.some((l) => l.includes("sandbox_inventory.incomplete"))).toBe(true);
  });

  it("a budget that covers every page reads it all, writes, and raises no code", async () => {
    const fake = createReaperSdkFake();
    seedMany(fake, 3); // 3 + 1 + 1 pages
    const { pool, calls } = poolStub();
    const result = await sandboxInventory({ pool, port: realPort(fake), log: () => undefined }, { now: 1, maxCalls: 5 });
    expect(result.callsUsed).toBe(5);
    expect(result.alerts).toEqual([]);
    expect(calls.length).toBe(1);
  });

  it("a budget of zero makes no provider call", async () => {
    const fake = createReaperSdkFake();
    seedMany(fake, 2);
    const { pool, calls } = poolStub();
    const result = await sandboxInventory({ pool, port: realPort(fake), log: () => undefined }, { now: 1, maxCalls: 0 });
    expect(fake.listQueries).toEqual([]);
    expect(result.callsUsed).toBe(0);
    expect(result.alerts).toEqual(["sandbox_inventory_budget_exhausted"]);
    expect(calls).toEqual([]);
  });

  it("with no budget given, every page is read and counted", async () => {
    const fake = createReaperSdkFake();
    seedMany(fake, 3);
    const result = await sandboxInventory({ pool: poolStub().pool, port: realPort(fake), log: () => undefined }, { now: 1 });
    expect(result.callsUsed).toBe(5);
  });
});
