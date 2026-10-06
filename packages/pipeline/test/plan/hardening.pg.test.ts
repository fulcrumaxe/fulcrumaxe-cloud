import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { pgHarness } from "../helpers/pgHarness.js";
import { seedAccount, seedRepo } from "../build/helpers/seed.js";
import { runTriageStep, type TriageStepInput } from "../../src/plan/step.js";
import { triageIntake, isValidSourceEventId } from "../../src/plan/triage.js";
import { OWNER } from "./helpers/panelFixtures.js";
import type { TriageClassifier } from "../../src/plan/classifier.js";

const h = pgHarness();

async function tenant(): Promise<string> {
  const id = randomUUID();
  await seedAccount(h.admin, id);
  return id;
}

const classifierSpy = () => {
  const complete = vi.fn(async () => "feature");
  return { classifier: { complete } as TriageClassifier, complete };
};

/** A pool that counts every connection taken: zero means no query of any kind ran. */
function countingPool(inner: Pool): { pool: Pool; connects: () => number } {
  let n = 0;
  const pool = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "connect" || prop === "query") {
        return (...args: unknown[]) => {
          n++;
          return (target[prop as "connect"] as (...a: unknown[]) => unknown)(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { pool, connects: () => n };
}

const intake = (extra: Record<string, unknown>): TriageStepInput => ({ mode: "new", event: { ...OWNER, body: "body" }, title: "A title", ...extra }) as unknown as TriageStepInput;
const discussions = async (accountId: string): Promise<number> => Number((await h.admin.query<{ n: string }>(`SELECT count(*) AS n FROM discussions WHERE account_id = $1`, [accountId])).rows[0]!.n);

describe("C41 H15c-HARD-1: sourceEventId is read as an OWN data property (CWE-1321)", () => {
  it("with Object.prototype.sourceEventId set, an intake with no key of its own is refused invalid_source_event and merges into nothing", async () => {
    const accountId = await tenant();
    const { classifier, complete } = classifierSpy();
    const first = await runTriageStep({ pool: h.runWriterPool, accountId, classifier }, intake({ sourceEventId: "evt-victim" }));
    expect(first).toMatchObject({ status: "triaged" });
    complete.mockClear();

    const proto = Object.prototype as unknown as Record<string, unknown>;
    proto.sourceEventId = "evt-victim";
    try {
      // through the step, and straight into triage (the step's copy is not the only reader)
      const viaStep = await runTriageStep({ pool: h.runWriterPool, accountId, classifier }, intake({}));
      const viaTriage = await triageIntake({ pool: h.runWriterPool, accountId, classifier }, { mode: "new", trusted: true, title: "t", body: "b" } as never);
      expect(viaStep).toEqual({ status: "refused", reason: "invalid_source_event" });
      expect(viaTriage).toEqual({ status: "refused", reason: "invalid_source_event" });
    } finally {
      delete proto.sourceEventId;
    }
    expect(complete).not.toHaveBeenCalled();
    expect(await discussions(accountId)).toBe(1);
  });

  it("an accessor sourceEventId is not invoked and reads as missing", async () => {
    const accountId = await tenant();
    const { classifier, complete } = classifierSpy();
    const getter = vi.fn(() => "evt-from-getter");
    const input = intake({});
    Object.defineProperty(input, "sourceEventId", { get: getter, enumerable: true });
    expect(await runTriageStep({ pool: h.runWriterPool, accountId, classifier }, input)).toEqual({ status: "refused", reason: "invalid_source_event" });
    expect(getter).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(await discussions(accountId)).toBe(0);
  });
});

describe("C41 H15c-HARD-2: a key the store would reject is refused before the lookup (CWE-20)", () => {
  const BAD: Array<[string, unknown]> = [
    ["NUL", "evt\u0000x"],
    ["lone high surrogate", "evt\uD800"],
    ["lone low surrogate", "\uDC00evt"],
    ["empty", ""],
    ["over 200 chars", "e".repeat(201)],
    ["not a string (number)", 42],
    ["not a string (null)", null],
    ["not a string (object)", { toString: () => "evt" }],
    ["missing", undefined],
  ];

  it.each(BAD)("%s -> invalid_source_event: no pg error, no lookup, no model call", async (_name, key) => {
    const accountId = await tenant();
    const { classifier, complete } = classifierSpy();
    const counted = countingPool(h.runWriterPool);
    const out = await runTriageStep({ pool: counted.pool, accountId, classifier }, intake({ sourceEventId: key }));
    expect(out).toEqual({ status: "refused", reason: "invalid_source_event" });
    expect(counted.connects()).toBe(0);
    expect(complete).not.toHaveBeenCalled();
    expect(await discussions(accountId)).toBe(0);
  });

  it("the boundary keys the store accepts are accepted: 1 char, 200 chars, a well-formed surrogate pair", async () => {
    const accountId = await tenant();
    for (const key of ["e", "e".repeat(200), "evt-😀"]) {
      expect(isValidSourceEventId(key)).toBe(true);
      const out = await runTriageStep({ pool: h.runWriterPool, accountId, classifier: classifierSpy().classifier }, intake({ sourceEventId: key }));
      expect(out).toMatchObject({ status: "triaged" });
    }
    expect(await discussions(accountId)).toBe(3);
  });
});

describe("SECURITY SHOULD-3 (CWE-1321): event, title, repoId and mode are OWN data properties too", () => {
  const proto = Object.prototype as unknown as Record<string, unknown>;
  const withProto = async <T>(key: string, value: unknown, fn: () => Promise<T>): Promise<T> => {
    proto[key] = value;
    try {
      return await fn();
    } finally {
      delete proto[key];
    }
  };
  const workItems = async (accountId: string) => (await h.admin.query<{ repo_id: string | null }>(`SELECT repo_id FROM work_items WHERE account_id = $1`, [accountId])).rows;

  it("an inherited event does not make an eventless intake trusted: no classifier call, no discussion, same outcome as without the pollution", async () => {
    const accountId = await tenant();
    const { classifier, complete } = classifierSpy();
    const noEvent = { mode: "new", title: "no event of its own", sourceEventId: "evt-noevent" } as unknown as TriageStepInput;
    const clean = await runTriageStep({ pool: h.runWriterPool, accountId, classifier }, noEvent);
    const polluted = await withProto("event", { ...OWNER, body: "injected by prototype" }, () => runTriageStep({ pool: h.runWriterPool, accountId, classifier }, { ...noEvent, sourceEventId: "evt-noevent-2" } as TriageStepInput));
    expect(polluted).toMatchObject({ status: clean.status });
    expect(polluted.status).not.toBe("triaged");
    expect(complete).not.toHaveBeenCalled();
    expect(await discussions(accountId)).toBe(0);
  });

  it("an inherited repoId does not steer the created item", async () => {
    const accountId = await tenant();
    const repoId = randomUUID();
    await seedRepo(h.admin, accountId, repoId);
    const { classifier } = classifierSpy();
    const out = await withProto("repoId", repoId, () => runTriageStep({ pool: h.runWriterPool, accountId, classifier }, intake({ sourceEventId: "evt-repo" })));
    expect(out).toMatchObject({ status: "triaged" });
    expect(await workItems(accountId)).toEqual([{ repo_id: null }]);
  });

  it("an inherited title is not used: the intake with no title of its own creates nothing under it", async () => {
    const accountId = await tenant();
    const { classifier, complete } = classifierSpy();
    const noTitle = { mode: "new", event: { ...OWNER, body: "body" }, sourceEventId: "evt-title" } as unknown as TriageStepInput;
    const clean = await runTriageStep({ pool: h.runWriterPool, accountId, classifier }, noTitle);
    const before = await discussions(accountId);
    const polluted = await withProto("title", "INHERITED TITLE", () => runTriageStep({ pool: h.runWriterPool, accountId, classifier }, { ...noTitle, sourceEventId: "evt-title-2" } as TriageStepInput));
    expect(polluted).toEqual(clean);
    expect(await discussions(accountId)).toBe(before);
    expect(complete.mock.calls.flat().join("\n")).not.toContain("INHERITED TITLE");
    const titles = await h.admin.query<{ title: string }>(`SELECT title FROM discussions WHERE account_id = $1`, [accountId]);
    expect(titles.rows.map((r) => r.title)).not.toContain("INHERITED TITLE");
  });

  it("an inherited mode selects nothing: the step refuses invalid_mode", async () => {
    const accountId = await tenant();
    const { classifier, complete } = classifierSpy();
    for (const mode of ["new", "existing"]) {
      const out = await withProto("mode", mode, () => runTriageStep({ pool: h.runWriterPool, accountId, classifier }, { event: { ...OWNER, body: "b" }, title: "t", sourceEventId: "evt-mode" } as unknown as TriageStepInput));
      expect(out).toEqual({ status: "refused", reason: "invalid_mode" });
    }
    expect(complete).not.toHaveBeenCalled();
    expect(await discussions(accountId)).toBe(0);
  });
});

