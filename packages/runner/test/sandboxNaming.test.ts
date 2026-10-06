import { describe, expect, it } from "vitest";
import {
  EXECUTOR_KEEP_LAST_SNAPSHOTS,
  PR_EVENTS_THAT_DELETE_SANDBOX,
  isPersistentRole,
  parseSandboxName,
  retentionPolicyFor,
  sandboxNameFor,
} from "../src/sandboxNaming.js";
import type { Role } from "../src/types.js";

const NON_EXECUTOR_ROLES: Role[] = [
  "code-reviewer",
  "security-reviewer",
  "project-manager",
  "acceptance-tester",
  "browser-tester",
  "technical-architect",
  "product-owner",
  "cost-analyst",
  "performance-expert",
  "security-expert",
  "researcher",
];

// A `repos.id` UUID, as `sandboxNameFor` now requires -- never the raw
// GitHub repo id, which `packages/db/migrations/0001_core.sql` does not
// constrain UNIQUE (H09 security review, "must fix" 2).
const REPO_ID_A = "11111111-1111-4111-8111-111111111111";
const REPO_ID_B = "22222222-2222-4222-8222-222222222222";
// `accounts.id` UUIDs -- PR #85 fix round 3, must-fix 2: part of the
// name's injective triple alongside repoId/pr (see sandboxNaming.ts).
const ACCOUNT_ID_A = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID_B = "44444444-4444-4444-8444-444444444444";

/**
 * D#2 H09 pass/fail 6: "`persistent: false` for every role except
 * executor, whose sandbox is named `ex-{repoId}-{pr}` with
 * `keepLastSnapshots: 1` and is deleted on the `pr.closed` / `pr.merged`
 * event (test)." PR #85 fix round 3, must-fix 2 adds `accountId` into
 * that name (`ex-{accountId}-{repoId}-{pr}`) -- see the dedicated
 * describe block below for why.
 */
describe("sandbox persistence and naming (D#2 H09 pass/fail 6)", () => {
  it("persistent is false for every role except executor", () => {
    expect(isPersistentRole("executor")).toBe(true);
    for (const role of NON_EXECUTOR_ROLES) {
      expect(isPersistentRole(role)).toBe(false);
      expect(retentionPolicyFor(role)).toEqual({ persistent: false });
    }
  });

  it("executor's retention policy is persistent:true with keepLastSnapshots:1", () => {
    expect(retentionPolicyFor("executor")).toEqual({
      persistent: true,
      keepLastSnapshots: EXECUTOR_KEEP_LAST_SNAPSHOTS,
    });
    expect(EXECUTOR_KEEP_LAST_SNAPSHOTS).toBe(1);
  });

  it("executor's sandbox is named ex-{accountId}-{repoId}-{pr}, with accountId/repoId valid UUIDs", () => {
    const name = sandboxNameFor({ role: "executor", runId: "run-1", accountId: ACCOUNT_ID_A, repoId: REPO_ID_A, pr: 7 });
    expect(name).toBe(`ex-${ACCOUNT_ID_A}-${REPO_ID_A}-7`);
  });

  it("executor naming requires accountId, repoId and pr", () => {
    expect(() => sandboxNameFor({ role: "executor", runId: "run-1" })).toThrow();
    expect(() => sandboxNameFor({ role: "executor", runId: "run-1", repoId: REPO_ID_A })).toThrow();
    expect(() => sandboxNameFor({ role: "executor", runId: "run-1", accountId: ACCOUNT_ID_A })).toThrow();
    expect(() =>
      sandboxNameFor({ role: "executor", runId: "run-1", accountId: ACCOUNT_ID_A, repoId: REPO_ID_A }),
    ).toThrow();
  });

  it("non-executor roles get a runId-scoped name, not the ex-{repoId}-{pr} shape", () => {
    for (const role of NON_EXECUTOR_ROLES) {
      const name = sandboxNameFor({ role, runId: "run-99" });
      expect(name).toBe(`rn-${role.length}-${role}-run-99`);
      expect(name.startsWith("ex-")).toBe(false);
    }
  });

  it("the two PR lifecycle events that must delete the executor's sandbox are exactly pr.closed and pr.merged", () => {
    expect(PR_EVENTS_THAT_DELETE_SANDBOX).toEqual(["pr.closed", "pr.merged"]);
  });

  /**
   * H09 security review, "must fix" 2: three concrete collisions the
   * reviewer produced against the pre-fix naming scheme. Each is closed by
   * a different piece of the fix -- UUID validation, positive-safe-integer
   * validation, and a prefix disjoint from "ex-" -- so each gets its own
   * test rather than one combined assertion.
   */
  describe("tenant-safety and injectivity (H09 security review, must-fix 2)", () => {
    it("rejects a repoId that is not a repos.id UUID, e.g. a raw GitHub repo id -- the non-unique column that let two tenants collide", () => {
      // gh_repo_id/gh_installation_id have no UNIQUE constraint in
      // 0001_core.sql, so two different accounts' repos.id rows can both
      // point at the same GitHub repo id. Passing that numeric id through
      // as repoId must fail outright, not silently produce a name two
      // tenants could share.
      expect(() =>
        sandboxNameFor({ role: "executor", runId: "run-1", accountId: ACCOUNT_ID_A, repoId: "123456789", pr: 1 }),
      ).toThrow();
    });

    it("two different repos.id UUIDs (e.g. two tenants' rows for the same GitHub repo) always produce different sandbox names", () => {
      const nameA = sandboxNameFor({ role: "executor", runId: "run-1", accountId: ACCOUNT_ID_A, repoId: REPO_ID_A, pr: 1 });
      const nameB = sandboxNameFor({ role: "executor", runId: "run-1", accountId: ACCOUNT_ID_A, repoId: REPO_ID_B, pr: 1 });
      expect(nameA).not.toBe(nameB);
    });

    it("rejects a negative pr and a repoId shaped to create a '-{n}' ambiguity, closing the ('x-5-',6)/('x-5',-6) collision", () => {
      // Neither "x-5-" nor "x-5" is a valid UUID, so both are rejected
      // before pr's sign is even relevant -- the collision the reviewer
      // produced required both fields to accept arbitrary shapes.
      expect(() =>
        sandboxNameFor({ role: "executor", runId: "r", accountId: ACCOUNT_ID_A, repoId: "x-5-", pr: 6 }),
      ).toThrow();
      expect(() =>
        sandboxNameFor({ role: "executor", runId: "r", accountId: ACCOUNT_ID_A, repoId: "x-5", pr: -6 }),
      ).toThrow();
    });

    it("rejects a non-positive or unsafe pr even with a valid repoId", () => {
      expect(() =>
        sandboxNameFor({ role: "executor", runId: "run-1", accountId: ACCOUNT_ID_A, repoId: REPO_ID_A, pr: 0 }),
      ).toThrow();
      expect(() =>
        sandboxNameFor({ role: "executor", runId: "run-1", accountId: ACCOUNT_ID_A, repoId: REPO_ID_A, pr: -1 }),
      ).toThrow();
      expect(() =>
        sandboxNameFor({
          role: "executor",
          runId: "run-1",
          accountId: ACCOUNT_ID_A,
          repoId: REPO_ID_A,
          pr: Number.MAX_SAFE_INTEGER + 1,
        }),
      ).toThrow();
    });

    it("a hostile role of 'ex' never collides with a real executor name -- the non-executor prefix is disjoint from 'ex-'", () => {
      const hostileName = sandboxNameFor({ role: "ex", runId: "abc-5" });
      const executorName = sandboxNameFor({ role: "executor", runId: "run-1", accountId: ACCOUNT_ID_A, repoId: REPO_ID_A, pr: 5 });
      expect(hostileName).not.toBe(executorName);
      expect(hostileName.startsWith("ex-")).toBe(false);
      expect(hostileName.startsWith("rn-")).toBe(true);
    });

    it("no non-executor (role, runId) pair can ever start with the executor prefix", () => {
      for (const role of [...NON_EXECUTOR_ROLES, "ex", "executor-lookalike", ""]) {
        const name = sandboxNameFor({ role, runId: "run-1" });
        expect(name.startsWith("ex-")).toBe(false);
      }
    });

    it("two different (role, runId) pairs never collide with each other, even when one role is a prefix of the other with matching total length", () => {
      // Without the length prefix, role="a" runId="b-c" and role="a-b"
      // runId="c" would both join to "a-b-c". The embedded role.length
      // fixes exactly where role ends, so they no longer collide.
      const nameA = sandboxNameFor({ role: "a", runId: "b-c" });
      const nameB = sandboxNameFor({ role: "a-b", runId: "c" });
      expect(nameA).not.toBe(nameB);
    });
  });

  /**
   * PR #85 fix round 3, must-fix 2 (CWE-639/706/200): `repos.id` has no
   * UNIQUE constraint across accounts and no protection against reuse
   * after a delete -- a tenant can INSERT a `repos` row naming a UUID a
   * DIFFERENT (and possibly still-live) tenant used to own. Before this
   * fix, `ex-{repoId}-{pr}` let that reused id collide with another
   * tenant's still-live persistent sandbox name. `accountId` closes it
   * by becoming part of the injective triple.
   */
  describe("cross-tenant collision (PR #85 fix round 3, must-fix 2)", () => {
    it("the same (repoId, pr) pair produces different names for two different accounts -- the reused-repos.id collision this fix closes", () => {
      const nameA = sandboxNameFor({ role: "executor", runId: "run-1", accountId: ACCOUNT_ID_A, repoId: REPO_ID_A, pr: 5 });
      const nameB = sandboxNameFor({ role: "executor", runId: "run-1", accountId: ACCOUNT_ID_B, repoId: REPO_ID_A, pr: 5 });
      expect(nameA).not.toBe(nameB);
      expect(nameA).toBe(`ex-${ACCOUNT_ID_A}-${REPO_ID_A}-5`);
      expect(nameB).toBe(`ex-${ACCOUNT_ID_B}-${REPO_ID_A}-5`);
    });

    it("rejects an accountId that is not a UUID", () => {
      expect(() =>
        sandboxNameFor({ role: "executor", runId: "run-1", accountId: "not-a-uuid", repoId: REPO_ID_A, pr: 5 }),
      ).toThrow();
    });

    it("rejects an upper-case accountId UUID for the same reason repoId is rejected upper-case -- one canonical spelling, one name", () => {
      // ACCOUNT_ID_A/B above are all-digit UUIDs -- .toUpperCase() would
      // be a silent no-op on either (same pitfall the repoId-case block
      // above already documents), so this uses its own UUID with hex
      // letters, the only nibbles case affects.
      const accountIdHex = "55555555-e89b-12d3-a456-426614174000";
      expect(() =>
        sandboxNameFor({
          role: "executor",
          runId: "run-1",
          accountId: accountIdHex.toUpperCase(),
          repoId: REPO_ID_A,
          pr: 5,
        }),
      ).toThrow();
    });
  });

  /**
   * H09 security RE-review, "should fix" 2: `UUID_RE` used the `/i` flag,
   * so an upper-case (or mixed-case) repoId built a different sandbox
   * name than the lower-case spelling of the exact same UUID -- even
   * though Postgres always returns a `uuid` column's text form in lower
   * case, so both spellings denote the same `repos.id` row.
   */
  describe("repoId case (H09 security re-review, should-fix 2)", () => {
    // REPO_ID_A/REPO_ID_B above are all-digit UUIDs -- .toUpperCase() would
    // be a silent no-op on either, so this block uses its own UUID that
    // actually contains hex letters (a-f), the only nibbles case affects.
    const REPO_ID_HEX = "123e4567-e89b-12d3-a456-426614174000";
    const REPO_ID_HEX_UPPER = REPO_ID_HEX.toUpperCase();

    it("rejects an upper-case UUID even though it is the same repos.id as the accepted lower-case form", () => {
      expect(() =>
        sandboxNameFor({ role: "executor", runId: "run-1", accountId: ACCOUNT_ID_A, repoId: REPO_ID_HEX_UPPER, pr: 7 }),
      ).toThrow();
    });

    it("rejects a mixed-case UUID too", () => {
      const mixedCase = REPO_ID_HEX.slice(0, 8).toUpperCase() + REPO_ID_HEX.slice(8);
      expect(() =>
        sandboxNameFor({ role: "executor", runId: "run-1", accountId: ACCOUNT_ID_A, repoId: mixedCase, pr: 7 }),
      ).toThrow();
    });

    it("one repos.id (in its one canonical lower-case spelling) gives exactly one sandbox name -- there is no second, upper-case route to a different name for the same row", () => {
      const name = sandboxNameFor({ role: "executor", runId: "run-1", accountId: ACCOUNT_ID_A, repoId: REPO_ID_HEX, pr: 7 });
      expect(name).toBe(`ex-${ACCOUNT_ID_A}-${REPO_ID_HEX}-7`);
      expect(() =>
        sandboxNameFor({ role: "executor", runId: "run-1", accountId: ACCOUNT_ID_A, repoId: REPO_ID_HEX_UPPER, pr: 7 }),
      ).toThrow();
    });
  });

  /**
   * H09 security re-review, "suggestion" 5: a `bigint` `pr` was still
   * refused, but `JSON.stringify` cannot serialize a `bigint` and throws
   * its own `TypeError` from inside the error-message template literal --
   * so the caller got an unrelated, untyped crash instead of the
   * intended "pr must be a positive safe integer" `Error`.
   */
  it("a bigint pr is refused with the intended Error, not an unrelated TypeError from serializing it", () => {
    const hostilePr = 5n as unknown as number;
    expect(() =>
      sandboxNameFor({ role: "executor", runId: "run-1", accountId: ACCOUNT_ID_A, repoId: REPO_ID_A, pr: hostilePr }),
    ).toThrow(/pr must be a positive safe integer/);
  });
});

describe("parseSandboxName (D#2 SANDBOX-REAPER): reads back exactly what sandboxNameFor builds", () => {
  const RUN_ID = "33333333-3333-4333-8333-333333333333";

  it("round-trips an executor name and every other role's name", () => {
    expect(parseSandboxName(sandboxNameFor({ role: "executor", runId: RUN_ID, accountId: ACCOUNT_ID_A, repoId: REPO_ID_A, pr: 42 }))).toEqual({ kind: "executor", accountId: ACCOUNT_ID_A, repoId: REPO_ID_A, pr: 42 });
    for (const role of NON_EXECUTOR_ROLES) {
      expect(parseSandboxName(sandboxNameFor({ role, runId: RUN_ID }))).toEqual({ kind: "ephemeral", role, runId: RUN_ID });
    }
  });

  it("returns null for a foreign name, a near miss or a hostile one", () => {
    for (const name of [
      "", "rlr0-spike-1", "fx-sandbox-1", "ex-", "ex-1-2-3", `ex-${ACCOUNT_ID_A}-${REPO_ID_A}`, `ex-${ACCOUNT_ID_A}-${REPO_ID_A}-0`, `ex-${ACCOUNT_ID_A}-${REPO_ID_A}-007`,
      `ex-ABCDEFAB-1111-4111-8111-111111111111-${REPO_ID_A}-5`, `ex-${ACCOUNT_ID_A}-${REPO_ID_A}-5 `, `EX-${ACCOUNT_ID_A}-${REPO_ID_A}-5`,
      `rn-9-reviewer-${RUN_ID}`, `rn-8-reviewer-not-a-uuid`, `rn-x-reviewer-${RUN_ID}`, `xrn-8-reviewer-${RUN_ID}`,
    ]) {
      expect(parseSandboxName(name), JSON.stringify(name)).toBeNull();
    }
  });
});
