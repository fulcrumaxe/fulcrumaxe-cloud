import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDiscussion } from "@fx/discussions";
import { systemPrincipal } from "@fx/discussions/server";
import { pgHarness } from "../helpers/pgHarness.js";
import { seedAccount } from "../build/helpers/seed.js";
import { runTriageStep, type TriageStepInput } from "../../src/plan/step.js";
import { runPanel } from "../../src/plan/panel.js";
import type { TriageClassifier } from "../../src/plan/classifier.js";
import { FixtureRunner, fixtureClassifier, OWNER } from "./helpers/panelFixtures.js";

const h = pgHarness();

async function tenant(): Promise<string> {
  const id = randomUUID();
  await seedAccount(h.admin, id);
  return id;
}

async function n(table: string, accountId: string): Promise<number> {
  return Number((await h.admin.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE account_id = $1`, [accountId])).rows[0]!.n);
}

async function counts(accountId: string) {
  return {
    discussions: await n("discussions", accountId),
    workItems: await n("work_items", accountId),
    revisions: await n("discussion_revisions", accountId),
    transitions: await n("work_item_transitions", accountId),
  };
}

const newIntake = (sourceEventId: string, title = "Rotate the credentials store", body = "Store the secret token on the cloud server."): TriageStepInput => ({
  mode: "new",
  event: { ...OWNER, body },
  title,
  sourceEventId,
});

describe("C39 (c1) H15b-IDEM: replaying the same source event gives one discussion", () => {
  it("1: a crash between createDiscussion and setStage, then a replay with the same source event id (and different text): one discussion, one root work item, one transition", async () => {
    const accountId = await tenant();
    const evt = `evt-${randomUUID()}`;
    // The crashed first attempt: it got as far as createDiscussion and died before setStage.
    const first = await createDiscussion(
      { pool: h.runWriterPool, principal: systemPrincipal(accountId, "pipeline.triage") },
      { title: "Rotate the credentials store", kind: "feature", body: "Store the secret token on the cloud server.", sourceEventId: evt },
    );
    expect(await counts(accountId)).toEqual({ discussions: 1, workItems: 1, revisions: 1, transitions: 0 });

    const classifier = fixtureClassifier("critical"); // must not even be asked: the stored kind wins
    const out = await runTriageStep({ pool: h.runWriterPool, accountId, classifier }, newIntake(evt, "A different title", "A different body"));

    expect(out).toMatchObject({ status: "triaged", category: "feature", stage: "discussing", replayed: true, discussionId: first.id, workItemId: first.rootWorkItemId, discussionNumber: first.number });
    expect(classifier.calls).toHaveLength(0);
    expect(await counts(accountId)).toEqual({ discussions: 1, workItems: 1, revisions: 1, transitions: 1 });
    const row = await h.admin.query(`SELECT title FROM discussions WHERE id = $1`, [first.id]);
    expect(row.rows[0]).toEqual({ title: "Rotate the credentials store" });
    console.log("IDEM crash replay", JSON.stringify(await counts(accountId)));
  });

  it("1: replaying a completed intake again changes nothing", async () => {
    const accountId = await tenant();
    const evt = `evt-${randomUUID()}`;
    const deps = { pool: h.runWriterPool, accountId, classifier: fixtureClassifier("feature") };
    const a = await runTriageStep(deps, newIntake(evt));
    const before = await counts(accountId);
    const b = await runTriageStep(deps, newIntake(evt));
    const c = await runTriageStep(deps, newIntake(evt));
    expect(a).toMatchObject({ status: "triaged", stage: "discussing" });
    expect(a).not.toHaveProperty("replayed");
    for (const r of [b, c]) expect(r).toMatchObject({ status: "triaged", stage: "discussing", replayed: true, discussionId: (a as { discussionId: string }).discussionId });
    expect(await counts(accountId)).toEqual(before);
    expect(before).toEqual({ discussions: 1, workItems: 1, revisions: 1, transitions: 1 });
  });

  it("1: a created_not_staged first attempt is finished by replaying the same intake", async () => {
    const accountId = await tenant();
    const evt = `evt-${randomUUID()}`;
    // setStage fails the first time: block the transition with a failing pool wrapper on that one statement.
    let armed = true;
    const flaky = new Proxy(h.runWriterPool, {
      get(target, prop, receiver) {
        if (prop === "connect") {
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(c, p, r) {
                if (p === "query") {
                  return (...args: unknown[]) => {
                    const sql = typeof args[0] === "string" ? args[0] : "";
                    if (armed && /INSERT INTO work_item_transitions/i.test(sql)) return Promise.reject(new Error("simulated crash"));
                    return (c.query as (...a: unknown[]) => unknown)(...args);
                  };
                }
                const v = Reflect.get(c, p, r);
                return typeof v === "function" ? v.bind(c) : v;
              },
            });
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const first = await runTriageStep({ pool: flaky as never, accountId, classifier: fixtureClassifier("feature") }, newIntake(evt));
    expect(first.status).toBe("created_not_staged");
    expect(await counts(accountId)).toMatchObject({ discussions: 1, workItems: 1, transitions: 0 });
    armed = false;
    const second = await runTriageStep({ pool: h.runWriterPool, accountId, classifier: fixtureClassifier("feature") }, newIntake(evt));
    expect(second).toMatchObject({ status: "triaged", stage: "discussing", replayed: true });
    expect(await counts(accountId)).toEqual({ discussions: 1, workItems: 1, revisions: 1, transitions: 1 });
  });

  it("2: concurrent replays give one discussion, one transition, and the same ids", async () => {
    const accountId = await tenant();
    const evt = `evt-${randomUUID()}`;
    const deps = { pool: h.runWriterPool, accountId, classifier: fixtureClassifier("feature") };
    const outs = await Promise.all([1, 2, 3, 4, 5].map(() => runTriageStep(deps, newIntake(evt))));
    expect(new Set(outs.map((o) => (o as { discussionId: string }).discussionId)).size).toBe(1);
    expect(outs.every((o) => o.status === "triaged" && o.stage === "discussing")).toBe(true);
    expect(await counts(accountId)).toEqual({ discussions: 1, workItems: 1, revisions: 1, transitions: 1 });
  });

  it("2: when the racing attempt wins between the lookup and the create, the loser takes the winner's stored kind, not its own classification", async () => {
    const accountId = await tenant();
    const evt = `evt-${randomUUID()}`;
    let winner: { id: string } | null = null;
    // The classifier runs after the loser's lookup missed and before its create: the other attempt lands here.
    const racing: TriageClassifier = {
      complete: async () => {
        winner = await createDiscussion(
          { pool: h.runWriterPool, principal: systemPrincipal(accountId, "pipeline.triage") },
          { title: "winner", kind: "critical", body: "winner body", sourceEventId: evt },
        );
        return "feature";
      },
    };
    const out = await runTriageStep({ pool: h.runWriterPool, accountId, classifier: racing }, newIntake(evt));
    expect(out).toMatchObject({ status: "triaged", category: "critical", replayed: true, discussionId: winner!.id });
    expect(await counts(accountId)).toMatchObject({ discussions: 1, workItems: 1, revisions: 1 });
  });

  it("the key is per account: the same source event id in tenant B creates B's own discussion", async () => {
    const a = await tenant();
    const b = await tenant();
    const evt = `evt-${randomUUID()}`;
    const oa = await runTriageStep({ pool: h.runWriterPool, accountId: a, classifier: fixtureClassifier("feature") }, newIntake(evt));
    const ob = await runTriageStep({ pool: h.runWriterPool, accountId: b, classifier: fixtureClassifier("feature") }, newIntake(evt));
    expect((oa as { discussionId: string }).discussionId).not.toBe((ob as { discussionId: string }).discussionId);
    expect(ob).not.toHaveProperty("replayed");
  });

  it("a missing or malformed source event id is refused before any classification, and nothing is written", async () => {
    const accountId = await tenant();
    const classifier = fixtureClassifier("feature");
    for (const sourceEventId of [undefined, "", "x".repeat(201), 7, null, {}]) {
      const out = await runTriageStep({ pool: h.runWriterPool, accountId, classifier }, { ...newIntake("e"), sourceEventId } as never);
      expect(out).toEqual({ status: "refused", reason: "invalid_source_event" });
    }
    expect(classifier.calls).toHaveLength(0);
    expect(await counts(accountId)).toEqual({ discussions: 0, workItems: 0, revisions: 0, transitions: 0 });
  });

  it("an untrusted author is still refused first, whatever the source event id", async () => {
    const accountId = await tenant();
    const out = await runTriageStep(
      { pool: h.runWriterPool, accountId, classifier: fixtureClassifier("feature") },
      { mode: "new", event: { login: "s", repoPermission: "read", allowlist: [], body: "b" }, title: "t", sourceEventId: "evt-untrusted" },
    );
    expect(out).toEqual({ status: "refused", reason: "untrusted_intake" });
    expect(await counts(accountId)).toEqual({ discussions: 0, workItems: 0, revisions: 0, transitions: 0 });
  });
});

describe("whole-step replay after a simulated crash: one discussion, one comment per (discussion, run)", () => {
  async function signedPerRun(accountId: string) {
    const { rows } = await h.admin.query<{ discussion_id: string; agent_run_id: string; n: string }>(
      `SELECT discussion_id, agent_run_id, count(*) AS n FROM discussion_comments
        WHERE account_id = $1 AND system_signed GROUP BY 1, 2`,
      [accountId],
    );
    return rows;
  }

  it("intake -> panel crashes with two seats unanswered -> the whole step replays -> all expected comments, one row per run, one discussion", async () => {
    const accountId = await tenant();
    const evt = `evt-${randomUUID()}`;
    const classifier = fixtureClassifier("critical");
    const runner = new FixtureRunner(h.admin, accountId);
    runner.script["security-expert"] = { hang: true, ignoreAbort: true };
    runner.script["cost-analyst"] = { hang: true, ignoreAbort: true };

    // Run 1: the panel is cut off (the workflow died / timed out) with two seats unanswered.
    const t1 = await runTriageStep({ pool: h.runWriterPool, accountId, classifier }, newIntake(evt));
    if (t1.status !== "triaged") throw new Error("unreachable");
    const p1 = await runPanel({ pool: h.runWriterPool, accountId, runner, timeoutMs: 150 }, { workItemId: t1.workItemId });
    expect(p1).toMatchObject({ status: "completed", complete: false, missingRoles: ["security-expert", "cost-analyst"] });
    expect((await signedPerRun(accountId)).length).toBe(1);

    // The unanswered runs finish while the workflow is down. Replay the WHOLE step.
    runner.release();
    await new Promise((r) => setTimeout(r, 50));
    const t2 = await runTriageStep({ pool: h.runWriterPool, accountId, classifier }, newIntake(evt));
    expect(t2).toMatchObject({ status: "triaged", replayed: true, discussionId: t1.discussionId });
    const p2 = await runPanel({ pool: h.runWriterPool, accountId, runner, timeoutMs: 2000 }, { workItemId: t1.workItemId });
    expect(p2).toMatchObject({ status: "completed", complete: true, missingRoles: [] });

    // And once more, to prove a completed step is a no-op.
    const p3 = await runPanel({ pool: h.runWriterPool, accountId, runner, timeoutMs: 2000 }, { workItemId: t1.workItemId });
    expect(p3).toMatchObject({ status: "completed", complete: true });

    expect(await counts(accountId)).toEqual({ discussions: 1, workItems: 1, revisions: 1, transitions: 1 });
    const per = await signedPerRun(accountId);
    expect(per).toHaveLength(3);
    expect(per.every((r) => r.n === "1" && r.discussion_id === t1.discussionId)).toBe(true);
    console.log("REPLAY signed rows per (discussion, run)", JSON.stringify(per));
  });

  it("two concurrent panel replays write one signed row per (discussion, run)", async () => {
    const accountId = await tenant();
    const t = await runTriageStep({ pool: h.runWriterPool, accountId, classifier: fixtureClassifier("feature") }, newIntake(`evt-${randomUUID()}`));
    if (t.status !== "triaged") throw new Error("unreachable");
    const runner = new FixtureRunner(h.admin, accountId);
    const outs = await Promise.all([1, 2, 3].map(() => runPanel({ pool: h.runWriterPool, accountId, runner, timeoutMs: 3000 }, { workItemId: t.workItemId })));
    expect(outs.every((o) => o.status === "completed" && o.complete)).toBe(true);
    // The port hands the same run back for the same key; the store keeps one row per run.
    const per = await signedPerRun(accountId);
    expect(per.every((r) => r.n === "1")).toBe(true);
    expect(per).toHaveLength(3);
  });
});
