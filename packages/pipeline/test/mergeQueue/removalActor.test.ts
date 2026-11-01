import { describe, expect, it } from "vitest";
import { DEQUEUE_SUCCESS_CODES, dequeueReasonCode, removalFactReason } from "@fx/core/src/work-items/driverEvents.js";
import { queueActor } from "../../../github/src/eventMapper.js";
import { removalActor } from "../../src/mergeQueue/reconcile.js";

/** D#694 B6-6: the reconcile's actor rule, over GitHub's removal event. */
const HEAD = "a".repeat(40);
const ev = (over: Partial<{ reason: string | null; actorType: string | null; beforeCommitOid: string | null }> = {}) => ({ createdAt: "2026-11-01T10:00:00Z", reason: "DEQUEUED", actorType: "Bot", beforeCommitOid: HEAD, ...over });

describe("removalActor", () => {
  it("is the webhook's rule: the same reason and actor type give the same answer through both paths", () => {
    for (const reason of [null, "", "MANUAL", "manual", "DEQUEUED", "FAILED_REQUIRED_CHECKS", "MERGE_CONFLICT", "unspecified", 5 as never]) {
      for (const type of ["User", "Bot"]) {
        const webhook = queueActor(dequeueReasonCode(reason), type);
        expect(removalActor(ev({ reason, actorType: type }), HEAD), `${String(reason)} / ${type}`).toBe(webhook);
        // With a recent Remove press the fact is "you" on both paths (the webhook asks only for a reason that is not a success code); without one, the actor.
        const code = dequeueReasonCode(reason);
        for (const pressed of [false, true]) {
          const hook = removalFactReason(!DEQUEUE_SUCCESS_CODES.includes(code) && pressed, webhook);
          const reconcile = removalFactReason(pressed, removalActor(ev({ reason, actorType: type }), HEAD));
          if (!DEQUEUE_SUCCESS_CODES.includes(code)) expect(reconcile, `${String(reason)} / ${type} / pressed=${pressed}`).toBe(hook);
        }
      }
    }
    // The rule itself: a reason GitHub gave is the queue's own even from a User; with no reason, the type decides.
    expect(removalActor(ev({ actorType: "User" }), HEAD)).toBe("app");
    expect(removalActor(ev({ reason: null, actorType: "User" }), HEAD)).toBe("user");
    expect(removalActor(ev({ reason: null }), HEAD)).toBe("app");
  });
  it("the reason MANUAL is a person whatever the actor's type, in any case or spelling GitHub's code takes", () => {
    for (const reason of ["MANUAL", "manual", "Manual "]) expect(removalActor(ev({ reason }), HEAD)).toBe("user");
  });
  it("fails toward a person: no event, another head, no commit, no actor, or a type that is not a Bot", () => {
    expect(removalActor(null, HEAD)).toBe("user");
    expect(removalActor(undefined, HEAD)).toBe("user");
    expect(removalActor(ev({ beforeCommitOid: "b".repeat(40) }), HEAD)).toBe("user");
    expect(removalActor(ev({ beforeCommitOid: null }), HEAD)).toBe("user");
    expect(removalActor(ev({ actorType: null }), HEAD)).toBe("user");
    expect(removalActor(ev({ actorType: "Mannequin", reason: null }), HEAD)).toBe("user");
    expect(removalActor(ev({ actorType: "bot" }), HEAD)).toBe("user");
  });
});
