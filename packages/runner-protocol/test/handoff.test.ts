import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DETAILS_OF_RUN_ENDED, HANDED_OFF_DETAILS, LocalOnlyEvent, RUN_ENDED_REASONS } from "../src/messages.js";
import { HANDOFF_DEADLINE_MAX_LENGTH, HandoffSignal, HeartbeatReply } from "../src/replies.js";
import { fieldPaths, nonStrictObjects } from "./helpers/schemaWalk.js";

/** D#599 HO-1: handoff additions to the heartbeat reply and `run_ended`. Fixtures are pinned JSON files, not built in the test. */
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

/** The heartbeat schema and the event reasons as they were before D#599, copied here: what an already-installed runner enforces. */
const LegacyHeartbeatReply = z.object({ continue: z.literal(true), lease_expires_at: z.string().datetime() }).strict();
const LEGACY_REASONS = new Set(["job_refused", "repo_not_private", "agent_failed", "wall_clock", "runner_setup", "runner_shutdown", "push_rejected"]);

describe("heartbeat handoff signal (HO-1)", () => {
  const deadline = "2026-10-10T12:05:00.000Z";
  const base = { continue: true, lease_expires_at: "2026-10-10T12:01:30.000Z" };

  it("takes exactly { requested: true, deadline } and nothing else", () => {
    expect(HeartbeatReply.safeParse({ ...base, handoff: { requested: true, deadline } }).success).toBe(true);
    for (const bad of [
      { requested: true, deadline, note: "x" },
      { requested: true, deadline, extra: 1 },
      { requested: true, deadline, requested_by: "u" },
      { requested: false, deadline },
      { requested: "true", deadline },
      { requested: 1, deadline },
      { deadline },
      { requested: true },
      { requested: true, deadline: "soon" },
      { requested: true, deadline: "2026-10-10T12:05:00+02:00" },
      { requested: true, deadline: `2026-10-10T12:05:00.${"0".repeat(HANDOFF_DEADLINE_MAX_LENGTH)}Z` },
      {},
      null,
      "handoff",
    ]) {
      expect(HeartbeatReply.safeParse({ ...base, handoff: bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("is refused beside any unknown key on the reply, and with continue false", () => {
    expect(HeartbeatReply.safeParse({ ...base, handoff: { requested: true, deadline }, note: "x" }).success).toBe(false);
    expect(HeartbeatReply.safeParse({ continue: false, lease_expires_at: base.lease_expires_at, handoff: { requested: true, deadline } }).success).toBe(false);
  });

  it("is strict at every level and has no free-text field", () => {
    expect(nonStrictObjects(HeartbeatReply)).toEqual([]);
    expect(fieldPaths(HandoffSignal).sort()).toEqual(["deadline", "requested"]);
    // requested is a literal and deadline a bounded instant: neither can hold prose.
    expect(HandoffSignal.shape.requested.value).toBe(true);
    expect(HANDOFF_DEADLINE_MAX_LENGTH).toBe(30);
  });

  it("an older cloud's reply (no handoff) still parses on a newer runner, and its parsed form has no handoff", () => {
    const parsed = HeartbeatReply.parse(fixture("heartbeat-reply-legacy.json"));
    expect(parsed.handoff).toBeUndefined();
    expect(parsed.lease_expires_at).toBe("2026-10-10T12:01:30.000Z");
  });

  it("a newer cloud's reply with a handoff parses on a newer runner", () => {
    expect(HeartbeatReply.parse(fixture("heartbeat-reply-handoff.json")).handoff).toEqual({ requested: true, deadline });
  });

  it("pins the compatibility edge: a runner built before D#599 refuses a reply that carries handoff, so the cloud must not send it there", () => {
    expect(LegacyHeartbeatReply.safeParse(fixture("heartbeat-reply-legacy.json")).success).toBe(true);
    expect(LegacyHeartbeatReply.safeParse(fixture("heartbeat-reply-handoff.json")).success).toBe(false);
  });
});

describe("run_ended handed_off (HO-1)", () => {
  const ended = { seq: 1, ts: "2026-10-10T12:04:10.000Z", type: "run_ended" };

  it("DETAILS_OF_RUN_ENDED.handed_off is exactly pushed, push_failed, deadline", () => {
    expect(DETAILS_OF_RUN_ENDED.handed_off).toEqual(["pushed", "push_failed", "deadline"]);
    expect([...HANDED_OFF_DETAILS]).toEqual(["pushed", "push_failed", "deadline"]);
    expect(RUN_ENDED_REASONS).toContain("handed_off");
  });

  it("accepts each of the three details and also no detail", () => {
    for (const detail of HANDED_OFF_DETAILS) expect(LocalOnlyEvent.safeParse({ ...ended, reason: "handed_off", detail }).success, detail).toBe(true);
    expect(LocalOnlyEvent.safeParse({ ...ended, reason: "handed_off" }).success).toBe(true);
  });

  it("refuses a detail from another reason, free text, and the handed_off words on other reasons", () => {
    for (const detail of ["auth_missing", "duplicate_job", "other", "Pushed", "pushed to origin/fx/abc", ""]) {
      expect(LocalOnlyEvent.safeParse({ ...ended, reason: "handed_off", detail }).success, detail).toBe(false);
    }
    for (const reason of RUN_ENDED_REASONS.filter((r) => r !== "handed_off")) {
      for (const detail of ["pushed", "deadline"]) expect(LocalOnlyEvent.safeParse({ ...ended, reason, detail }).success, `${reason}/${detail}`).toBe(false);
    }
    // push_failed is also a runner_setup code, and stays one.
    expect(LocalOnlyEvent.safeParse({ ...ended, reason: "runner_setup", detail: "push_failed" }).success).toBe(true);
  });

  it("carries no text: every extra field, including activity and size_mb, is refused", () => {
    const ok = { ...ended, reason: "handed_off", detail: "pushed" };
    for (const extra of [{ note: "done" }, { summary: "x" }, { sha: "a".repeat(40) }, { message: "m" }, { size_mb: 5 }, { activity: "editing" }, { tool_name: "Bash" }, { file_path: "a.ts" }, { stage: "cloned" }, { reset_at: "2026-10-10T12:05:00.000Z" }]) {
      expect(LocalOnlyEvent.safeParse({ ...ok, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it("the pinned handed_off event parses on a newer cloud and is a reason an older cloud does not know, so a runner sends it only after the cloud is deployed", () => {
    expect(LocalOnlyEvent.parse(fixture("run-ended-handed-off.json"))).toMatchObject({ reason: "handed_off", detail: "pushed" });
    const handedOff = fixture("run-ended-handed-off.json") as { reason: string };
    expect(LEGACY_REASONS.has(handedOff.reason)).toBe(false);
  });

  it("an older runner's run_ended still parses on the newer cloud, and only handed_off is new", () => {
    const legacy = fixture("run-ended-legacy.json") as { reason: string };
    expect(LEGACY_REASONS.has(legacy.reason)).toBe(true);
    expect(LocalOnlyEvent.safeParse(legacy).success).toBe(true);
    for (const reason of LEGACY_REASONS) expect(RUN_ENDED_REASONS).toContain(reason);
    expect(RUN_ENDED_REASONS.filter((r) => !LEGACY_REASONS.has(r))).toEqual(["handed_off"]);
  });
});
