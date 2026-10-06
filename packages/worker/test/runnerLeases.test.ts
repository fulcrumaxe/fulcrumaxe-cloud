import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { FailureReason } from "@fx/runner";
import * as publicSurface from "../src/index.js";
import { RunActionInputError } from "../src/index.js";
import { RUNNER_LEASE_FAIL_REASONS, createRunnerLeaseFacade, type RunnerLeaseFailReason } from "../src/runnerLeases.js";
import { RUNNER_LOGIN_NAME, countScannedFiles, scanRunnerLoginReaders } from "./support/scanRunnerLoginReaders.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const UUID = "6f9619ff-8b86-4011-b42d-00c04fc964ff";

/** A pool that records any SQL attempted and fails it. */
function untouchedPool(): { pool: Pool; calls: string[] } {
  const calls: string[] = [];
  const fail = (what: string) => async (): Promise<never> => {
    calls.push(what);
    throw new Error(`unexpected ${what}`);
  };
  return { pool: { query: fail("query"), connect: fail("connect") } as unknown as Pool, calls };
}

describe("failRunnerLeases: input is checked before any SQL", () => {
  const bad: Array<[string, unknown]> = [
    ["a reason outside the list", { accountId: UUID, runnerId: UUID, reason: "runner_lost" }],
    ["no reason", { accountId: UUID, runnerId: UUID }],
    ["a reason that is not a string", { accountId: UUID, runnerId: UUID, reason: ["runner_revoked"] }],
    ["an account id that is not a uuid", { accountId: "a", runnerId: UUID, reason: "runner_revoked" }],
    ["a runner id that is not a uuid", { accountId: UUID, runnerId: "1; DROP TABLE runners", reason: "runner_revoked" }],
    ["no account id", { runnerId: UUID, reason: "runner_revoked" }],
    ["null", null],
    ["a string", "runner_revoked"],
  ];
  it.each(bad)("%s is refused with the fixed error and no query", async (_label, input) => {
    const { pool, calls } = untouchedPool();
    const err = await createRunnerLeaseFacade(pool).failRunnerLeases(input as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunActionInputError);
    expect((err as Error).message).toBe("run action: invalid input");
    expect(calls).toEqual([]);
  });
});

describe("the reason list", () => {
  it("starts as runner_revoked only, and every member is a FailureReason", () => {
    expect([...RUNNER_LEASE_FAIL_REASONS]).toEqual(["runner_revoked"]);
    expectTypeOf<RunnerLeaseFailReason>().toMatchTypeOf<FailureReason>();
    const asFailureReasons: readonly FailureReason[] = RUNNER_LEASE_FAIL_REASONS;
    expect(asFailureReasons).toContain("runner_revoked");
    // runner_lost was already a FailureReason; R2b adds it to the facade's list.
    const lost: FailureReason = "runner_lost";
    expect(lost).toBe("runner_lost");
  });
});

describe("CARRY-8 still holds with the lease facade in the tree", () => {
  it("no source anywhere but pools.ts reads or names the runner login variable", () => {
    expect(countScannedFiles(REPO_ROOT)).toBeGreaterThan(1500);
    expect(scanRunnerLoginReaders(REPO_ROOT)).toEqual([]);
  });

  it("the lease facade's own source does not name it, read the environment or import the pools module", () => {
    const source = readFileSync(path.join(REPO_ROOT, "packages", "worker", "src", "runnerLeases.ts"), "utf8");
    expect(source.includes(RUNNER_LOGIN_NAME)).toBe(false);
    expect(source).not.toMatch(/process\.env|from "\.\/pools\.js"/);
  });

  it("the package entry exports the method's types and reason list, never the factory that takes a pool", () => {
    expect("createRunnerLeaseFacade" in publicSurface).toBe(false);
    expect(Object.keys(publicSurface).filter((k) => /RUNNER_LOGIN|RUN_WRITER|Pool/i.test(k))).toEqual([]);
  });
});
