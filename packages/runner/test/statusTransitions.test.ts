import { describe, expect, it } from "vitest";
import {
  IllegalRunTransitionError,
  IllegalWorkItemTransitionError,
  RUN_STATUS_TRANSITIONS,
  WORK_ITEM_STATE_TRANSITIONS,
  assertLegalRunTransition,
  assertLegalWorkItemTransition,
  isLegalRunTransition,
  isLegalWorkItemTransition,
  type RunStatus,
  type WorkItemState,
} from "../src/statusTransitions.js";

/**
 * sec-criteria A8: "Each owning task defines the legal values and
 * transitions in one place and tests that an illegal transition is
 * refused." These tests are that proof for `agent_runs.status` and
 * `work_items.state`.
 */
describe("agent_runs.status state machine (A8)", () => {
  const allStatuses = Object.keys(RUN_STATUS_TRANSITIONS) as RunStatus[];

  it("admits every transition the table declares legal", () => {
    for (const from of allStatuses) {
      for (const to of RUN_STATUS_TRANSITIONS[from]) {
        expect(isLegalRunTransition(from, to)).toBe(true);
        expect(() => assertLegalRunTransition(from, to)).not.toThrow();
      }
    }
  });

  it("refuses every transition the table does not declare legal", () => {
    let checked = 0;
    for (const from of allStatuses) {
      for (const to of allStatuses) {
        if (RUN_STATUS_TRANSITIONS[from].includes(to)) continue;
        checked++;
        expect(isLegalRunTransition(from, to)).toBe(false);
        expect(() => assertLegalRunTransition(from, to)).toThrow(IllegalRunTransitionError);
      }
    }
    // Sanity: there really are illegal pairs being exercised, not an
    // accidentally-empty double loop.
    expect(checked).toBeGreaterThan(0);
  });

  it("every status other than pending, running and paused is terminal", () => {
    const NON_TERMINAL: readonly RunStatus[] = ["pending", "running", "paused"];
    for (const status of allStatuses) {
      if (NON_TERMINAL.includes(status)) continue;
      expect(RUN_STATUS_TRANSITIONS[status]).toEqual([]);
    }
  });

  it("refuses re-entering a terminal state, including a no-op self-transition", () => {
    expect(() => assertLegalRunTransition("succeeded", "succeeded")).toThrow(IllegalRunTransitionError);
    expect(() => assertLegalRunTransition("failed", "running")).toThrow(IllegalRunTransitionError);
  });

  it("carries the from/to pair on the thrown error", () => {
    let thrown: unknown;
    try {
      assertLegalRunTransition("succeeded", "running");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(IllegalRunTransitionError);
    const typed = thrown as IllegalRunTransitionError;
    expect(typed.from).toBe("succeeded");
    expect(typed.to).toBe("running");
  });

  it("Spec-named transitions used by H09b are legal: pending->refused_spend, pending->running, running->timed_out, running->killed_spend", () => {
    expect(isLegalRunTransition("pending", "refused_spend")).toBe(true);
    expect(isLegalRunTransition("pending", "running")).toBe(true);
    expect(isLegalRunTransition("running", "timed_out")).toBe(true);
    expect(isLegalRunTransition("running", "killed_spend")).toBe(true);
  });

  /**
   * D#2 H09b, correction C10, pass/fail 12: "`stopped` is removed. A test
   * asserts that `RunStatus` has no `stopped` member and
   * `RUN_STATUS_TRANSITIONS` has no `stopped` key."
   */
  it("stopped is removed: no key in RUN_STATUS_TRANSITIONS, and the type carries no such member", () => {
    expect(Object.hasOwn(RUN_STATUS_TRANSITIONS, "stopped")).toBe(false);
    expect(allStatuses).not.toContain("stopped");
    // @ts-expect-error -- "stopped" is no longer a member of RunStatus at
    // the type level; this line only compiles if that regresses.
    const _typeCheck: RunStatus = "stopped";
    void _typeCheck;
  });

  /**
   * D#2 H09b, correction C10, "New run edge `pending -> timed_out` (the
   * queue TTL)" and pass/fail 11: "`pending -> timed_out` is legal and has
   * its own legality test." Distinct from the pre-existing
   * `running -> timed_out` (the post-dispatch watchdog) asserted above.
   */
  it("pending->timed_out (the queue TTL, C10) is legal", () => {
    expect(isLegalRunTransition("pending", "timed_out")).toBe(true);
    expect(() => assertLegalRunTransition("pending", "timed_out")).not.toThrow();
  });

  /**
   * Correction C7 on D#2 (brief-only note for H09): "`stop(runId)` is
   * callable from a request handler (D#31 API-6). `cancelled` is a
   * terminal run status." D#31 API-6 pass/fail 1's own acceptance test
   * cancels "a seeded running run"; pass/fail 5 above already lets a key
   * failure leave a run `paused`, and a `pending` run has not started yet
   * -- all three are states a user cancel can interrupt, so `cancelled`
   * must be reachable from each. Each assertion here is a mutation
   * witness: deleting `"cancelled"` from any one of
   * `RUN_STATUS_TRANSITIONS.pending`/`.running`/`.paused` fails exactly
   * that assertion.
   */
  it("cancelled (C7 / D#31 API-6) is legal from pending, running and paused", () => {
    expect(isLegalRunTransition("pending", "cancelled")).toBe(true);
    expect(isLegalRunTransition("running", "cancelled")).toBe(true);
    expect(isLegalRunTransition("paused", "cancelled")).toBe(true);
    expect(() => assertLegalRunTransition("pending", "cancelled")).not.toThrow();
    expect(() => assertLegalRunTransition("running", "cancelled")).not.toThrow();
    expect(() => assertLegalRunTransition("paused", "cancelled")).not.toThrow();
  });

  /**
   * `cancelled` is terminal: deleting this assertion (or letting a future
   * edit give `cancelled` an outgoing edge) is caught here directly, and
   * also by the generic "every status ... is terminal" and "refuses every
   * transition the table does not declare legal" tests above, which both
   * iterate `Object.keys(RUN_STATUS_TRANSITIONS)` and so already cover any
   * key present in the table without needing a name added by hand.
   */
  it("cancelled has no legal outgoing transition, including to itself", () => {
    expect(RUN_STATUS_TRANSITIONS.cancelled).toEqual([]);
    for (const to of allStatuses) {
      expect(isLegalRunTransition("cancelled", to)).toBe(false);
      expect(() => assertLegalRunTransition("cancelled", to)).toThrow(IllegalRunTransitionError);
    }
  });

  /**
   * H09 security review, "should fix" 4: `Object.freeze` on the table
   * itself is shallow -- the inner arrays were mutable, so
   * `.paused.push("running")` made an otherwise-illegal transition legal.
   */
  it("the table's inner arrays are frozen too: push either throws or has no effect", () => {
    const before = [...RUN_STATUS_TRANSITIONS.paused];
    try {
      // @ts-expect-error -- readonly at the type level; this proves it's
      // also enforced at runtime, not just by TypeScript.
      RUN_STATUS_TRANSITIONS.paused.push("running");
    } catch {
      // Strict-mode push on a frozen array throws -- also acceptable.
    }
    expect(RUN_STATUS_TRANSITIONS.paused).toEqual(before);
    expect(isLegalRunTransition("paused", "running")).toBe(false);
    expect(() => assertLegalRunTransition("paused", "running")).toThrow(IllegalRunTransitionError);
  });

  /**
   * H09 security review, "should fix" 4: an unknown `from` -- unchecked
   * `text` from the database, or a prototype-chain name -- must refuse
   * via the typed error, never a raw `TypeError` from indexing undefined
   * or `Object.prototype`.
   */
  it.each(["not-a-status", "__proto__", "constructor", "toString", "hasOwnProperty"])(
    "refuses an unknown from-state (%s) with the typed error, not a TypeError",
    (badFrom) => {
      expect(isLegalRunTransition(badFrom as RunStatus, "running")).toBe(false);
      expect(() => assertLegalRunTransition(badFrom as RunStatus, "running")).toThrow(IllegalRunTransitionError);
    },
  );
});

describe("work_items.state state machine (A8)", () => {
  const allStates = Object.keys(WORK_ITEM_STATE_TRANSITIONS) as WorkItemState[];

  it("admits every transition the table declares legal", () => {
    for (const from of allStates) {
      for (const to of WORK_ITEM_STATE_TRANSITIONS[from]) {
        expect(isLegalWorkItemTransition(from, to)).toBe(true);
        expect(() => assertLegalWorkItemTransition(from, to)).not.toThrow();
      }
    }
  });

  it("refuses every transition the table does not declare legal", () => {
    let checked = 0;
    for (const from of allStates) {
      for (const to of allStates) {
        if (WORK_ITEM_STATE_TRANSITIONS[from].includes(to)) continue;
        checked++;
        expect(isLegalWorkItemTransition(from, to)).toBe(false);
        expect(() => assertLegalWorkItemTransition(from, to)).toThrow(IllegalWorkItemTransitionError);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("refuses skipping queued -> running straight to succeeded/failed", () => {
    expect(() => assertLegalWorkItemTransition("queued", "succeeded")).toThrow(IllegalWorkItemTransitionError);
    expect(() => assertLegalWorkItemTransition("queued", "failed")).toThrow(IllegalWorkItemTransitionError);
  });

  it("refuses re-entering a terminal state", () => {
    expect(() => assertLegalWorkItemTransition("succeeded", "running")).toThrow(IllegalWorkItemTransitionError);
    expect(() => assertLegalWorkItemTransition("failed", "queued")).toThrow(IllegalWorkItemTransitionError);
  });

  /**
   * H09 security review, "should fix" 4: the same shallow-freeze gap the
   * reviewer demonstrated on `RUN_STATUS_TRANSITIONS.paused` also applied
   * here -- `.succeeded.push("running")` made that terminal state
   * non-terminal.
   */
  it("the table's inner arrays are frozen too: push either throws or has no effect", () => {
    const before = [...WORK_ITEM_STATE_TRANSITIONS.succeeded];
    try {
      // @ts-expect-error -- readonly at the type level; this proves it's
      // also enforced at runtime, not just by TypeScript.
      WORK_ITEM_STATE_TRANSITIONS.succeeded.push("running");
    } catch {
      // Strict-mode push on a frozen array throws -- also acceptable.
    }
    expect(WORK_ITEM_STATE_TRANSITIONS.succeeded).toEqual(before);
    expect(isLegalWorkItemTransition("succeeded", "running")).toBe(false);
    expect(() => assertLegalWorkItemTransition("succeeded", "running")).toThrow(IllegalWorkItemTransitionError);
  });

  it.each(["not-a-state", "__proto__", "constructor", "toString", "hasOwnProperty"])(
    "refuses an unknown from-state (%s) with the typed error, not a TypeError",
    (badFrom) => {
      expect(isLegalWorkItemTransition(badFrom as WorkItemState, "running")).toBe(false);
      expect(() => assertLegalWorkItemTransition(badFrom as WorkItemState, "running")).toThrow(
        IllegalWorkItemTransitionError,
      );
    },
  );
});
