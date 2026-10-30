import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createResendTransport, notifyAsks } from "@fx/notify";
import { newResendWorld, startStrictResend, type StrictResend } from "@fx/notify/test/helpers/strictResend.js";
import { runAskWindowTick } from "../src/askWindowTick.js";

/**
 * [pg] D#7 DP12b-2: notifyAsks against real Postgres (a receipt login: app_user + receipt_writer_invoker) and the strict Resend fake over real TLS.
 * No real mail: the transport is pointed at a local receiver. The question and option text carry a marker that must never appear in a captured request.
 */
const INVOKER_LOGIN = "fx_ask_notify_sender_test";
const KEY = "re_test_key_fixed";
const MARK = "QUESTION-OPTION-TEXT";
const OPTIONS = [{ id: "apply", label: `${MARK} apply` }, { id: "skip", label: `${MARK} skip` }];
const ENV = { RESEND_API_KEY: KEY, NOTIFY_FROM: "Fulcrumaxe <ask@verified.example>", FX_APP_ORIGIN: "https://app.example" };

describe("notifyAsks [pg]", { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let fake: StrictResend;
  let lines: string[];

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INVOKER_LOGIN}') THEN CREATE ROLE ${INVOKER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${INVOKER_LOGIN}`);
    const u = new URL(process.env.WORKER_DATABASE_URL_APP_USER!);
    u.username = INVOKER_LOGIN;
    u.password = "";
    receiptPool = createPool(u.toString());
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, receiptPool]) await p.end();
  });
  beforeEach(async () => {
    lines = [];
    fake = await startStrictResend(newResendWorld([KEY], ["verified.example"]));
    // Other test files leave asks behind in this shared database: record them as long since emailed so only this test's asks are due.
    await shiftStamps(`state IN ('open', 'overdue')`, -120, true);
  });
  afterEach(async () => {
    await fake.close();
  });

  const makeTransport = ({ apiKey }: { apiKey: string }) => createResendTransport({ apiKey, testTarget: { lookup: fake.lookup, port: fake.port, ca: fake.ca } });
  const run = (env: Record<string, string | undefined> = ENV) => notifyAsks({ pool: receiptPool, env, warn: (l) => lines.push(l), makeTransport });

  /** The immutability guard is bypassed for one admin statement; `fill` first stamps NULL columns, then every stamp moves `minutes` (negative: into the past). */
  async function shiftStamps(where: string, minutes: number, fill = false): Promise<void> {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      if (fill) {
        await admin.query(`UPDATE decision_asks SET notified_at = now() + make_interval(mins => $1) WHERE ${where} AND notified_at IS NULL`, [minutes]);
        await admin.query(`UPDATE decision_asks SET renotified_at = now() + make_interval(mins => $1) WHERE ${where} AND state = 'overdue' AND renotified_at IS NULL`, [minutes]);
      } else {
        await admin.query(`UPDATE decision_asks SET notified_at = notified_at + make_interval(mins => $1), renotified_at = renotified_at + make_interval(mins => $1) WHERE ${where}`, [minutes]);
      }
      await admin.query("COMMIT");
    } catch (err) {
      await admin.query("ROLLBACK");
      throw err;
    }
  }
  async function account(roles: Array<"owner" | "admin" | "member"> = ["owner"]): Promise<{ refs: SeedRefs; emails: string[] }> {
    const refs = await seedAccount(admin, randomUUID());
    await admin.query("DELETE FROM account_members WHERE account_id = $1", [refs.accountId]);
    const emails: string[] = [];
    for (const role of roles) {
      const id = randomUUID();
      const email = `${role}-${id}@example.test`;
      await admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, email]);
      await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [refs.accountId, id, role]);
      if (role !== "member") emails.push(email);
    }
    return { refs, emails };
  }
  async function ask(a: SeedRefs, state: "open" | "overdue" = "open", timeout: "stop_and_flag" | "proceed_recommended" = "stop_and_flag"): Promise<string> {
    const itemId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'issue', 'internal', 'in_progress')`, [itemId, a.accountId, a.repoId]);
    const id = await withTenant(receiptPool, a.accountId, async (c) =>
      (await c.query<{ id: string }>(
        `SELECT decision_ask_raise('human_over_the_loop', 'test_strategy_choice', $1::uuid, NULL, $2::jsonb, 'apply', 'because', '["trusted"]'::jsonb, 60, $3, 0) AS id`,
        [itemId, JSON.stringify(OPTIONS), timeout])).rows[0]!.id);
    if (state === "overdue") await admin.query("UPDATE decision_asks SET state = 'overdue' WHERE id = $1", [id]);
    return id;
  }
  const stamps = async (id: string) => (await admin.query("SELECT notified_at, renotified_at FROM decision_asks WHERE id = $1", [id])).rows[0]!;
  const sentTo = (emails: string[]) => fake.world.sent.filter((m) => m.to.some((t) => emails.includes(t)));

  it("two asks due in one account inside the window produce ONE email to the owners and admins only, and both are stamped", async () => {
    const { refs, emails } = await account(["owner", "admin", "member"]);
    const [a, b] = [await ask(refs), await ask(refs)];
    const res = await run();
    expect(res).toMatchObject({ sent: 1, stamped: 2, failed: 0, disabled: false });
    const mails = sentTo(emails);
    expect(mails.length).toBe(1);
    expect(mails[0]!.to.sort()).toEqual([...emails].sort());
    expect(mails[0]!.subject).toBe("2 decisions are waiting for you");
    expect((await stamps(a)).notified_at).toBeInstanceOf(Date);
    expect((await stamps(b)).notified_at).toBeInstanceOf(Date);
  });

  it("a second tick inside 15 minutes sends nothing, even for a new ask; after 15 minutes it sends", async () => {
    const { refs, emails } = await account();
    await ask(refs);
    await run();
    const later = await ask(refs);
    await run();
    expect(sentTo(emails).length).toBe(1);
    expect((await stamps(later)).notified_at).toBeNull();
    await shiftStamps(`account_id = '${refs.accountId}'`, -16);
    await run();
    expect(sentTo(emails).length).toBe(2);
    expect((await stamps(later)).notified_at).toBeInstanceOf(Date);
  });

  it("no ask gets a third email across 10 ticks: one first email, then one reminder when overdue, then nothing", async () => {
    const { refs, emails } = await account();
    const id = await ask(refs);
    for (let tick = 0; tick < 10; tick++) {
      if (tick === 3) await admin.query("UPDATE decision_asks SET state = 'overdue' WHERE id = $1", [id]);
      await run();
      await shiftStamps(`account_id = '${refs.accountId}'`, -16);
    }
    const mails = sentTo(emails);
    expect(mails.map((m) => m.subject)).toEqual(["A decision is waiting for you", "Reminder: a decision is overdue"]);
  });

  it("an overdue ask that never got a first email gets the reminder only", async () => {
    const { refs, emails } = await account();
    const id = await ask(refs, "overdue");
    await run();
    expect(sentTo(emails).map((m) => m.subject)).toEqual(["Reminder: a decision is overdue"]);
    const s = await stamps(id);
    expect(s.notified_at).toBeNull();
    expect(s.renotified_at).toBeInstanceOf(Date);
  });

  it("an ask whose timeout is proceed_recommended sends nothing and is not stamped", async () => {
    const { refs, emails } = await account();
    const id = await ask(refs, "open", "proceed_recommended");
    const res = await run();
    expect(res.sent).toBe(0);
    expect(sentTo(emails)).toEqual([]);
    expect((await stamps(id)).notified_at).toBeNull();
  });

  it("with the key unset: nothing is sent or stamped, exactly one fixed line per tick, and the fake saw zero requests", async () => {
    const { refs } = await account();
    const id = await ask(refs);
    for (const env of [{ ...ENV, RESEND_API_KEY: undefined }]) {
      expect(await run(env)).toMatchObject({ sent: 0, disabled: true });
      expect(await run(env)).toMatchObject({ sent: 0, disabled: true });
    }
    expect(lines).toEqual(Array(2).fill('{"event":"notify.email_disabled","reason":"no_resend_key"}'));
    expect(await run({ ...ENV, NOTIFY_FROM: undefined })).toMatchObject({ disabled: true });
    expect(lines[2]).toBe('{"event":"notify.email_disabled","reason":"no_from_address"}');
    expect(fake.requests).toEqual([]);
    expect((await stamps(id)).notified_at).toBeNull();
  });

  it("asks raised while off go out as one batch per account when it is turned on, and an ask that ended meanwhile is never emailed", async () => {
    const { refs, emails } = await account();
    const [a, b] = [await ask(refs), await ask(refs)];
    const ended = await ask(refs);
    await admin.query("UPDATE decision_asks SET state = 'withdrawn' WHERE id = $1", [ended]);
    await run({});
    expect(fake.requests).toEqual([]);
    await run();
    expect(sentTo(emails).length).toBe(1);
    expect(sentTo(emails)[0]!.subject).toBe("2 decisions are waiting for you");
    expect((await stamps(a)).notified_at).toBeInstanceOf(Date);
    expect((await stamps(b)).notified_at).toBeInstanceOf(Date);
    expect((await stamps(ended)).notified_at).toBeNull();
  });

  it("a 429 or 5xx leaves the stamp unset and the next tick sends once", async () => {
    for (const status of [429, 503]) {
      const { refs, emails } = await account();
      const id = await ask(refs);
      fake.world.failNext.push(status);
      expect(await run()).toMatchObject({ sent: 0, failed: 1 });
      expect((await stamps(id)).notified_at).toBeNull();
      expect(await run()).toMatchObject({ sent: 1, failed: 0 });
      expect(sentTo(emails).length).toBe(1);
    }
    expect(lines.filter((l) => l.includes("notify.send_failed")).map((l) => JSON.parse(l).code)).toEqual(["rate_limited", "server_error"]);
  });

  it("a 4xx other than 429 is counted and stamped so it is not retried forever; a wrong key (401/403) stamps nothing and ends the tick", async () => {
    const { refs, emails } = await account();
    const id = await ask(refs);
    fake.world.failNext.push(422);
    expect(await run()).toMatchObject({ sent: 0, failed: 1 });
    expect((await stamps(id)).notified_at).toBeInstanceOf(Date);
    expect(lines).toContain('{"event":"notify.send_rejected","code":"rejected"}');
    expect(await run()).toMatchObject({ sent: 0, failed: 0 });
    expect(sentTo(emails)).toEqual([]);

    const other = await account();
    const id2 = await ask(other.refs);
    expect(await notifyAsks({ pool: receiptPool, env: { ...ENV, RESEND_API_KEY: "re_wrong" }, warn: (l) => lines.push(l), makeTransport })).toMatchObject({ sent: 0, failed: 1 });
    expect((await stamps(id2)).notified_at).toBeNull();
  });

  it("two overlapping ticks send exactly one email (the compare-and-set and the account lock)", async () => {
    const { refs, emails } = await account();
    const id = await ask(refs);
    let release!: () => void;
    fake.world.gate = new Promise<void>((r) => (release = r));
    const first = run();
    await new Promise((r) => setTimeout(r, 400));
    const second = await run();
    release();
    const done = await first;
    expect(done.sent + second.sent).toBe(1);
    expect(sentTo(emails).length).toBe(1);
    expect((await stamps(id)).notified_at).toBeInstanceOf(Date);
  });

  it("a send that never answers is cut at the bound: the transaction ends, nothing is stamped, and the lock is free for the next tick", async () => {
    const { refs, emails } = await account();
    const id = await ask(refs);
    const hung = { send: () => new Promise<never>(() => undefined) };
    const res = await notifyAsks({ pool: receiptPool, env: ENV, warn: (l) => lines.push(l), makeTransport: () => hung, sendBoundMs: 200 });
    expect(res).toMatchObject({ sent: 0, failed: 1 });
    expect(lines).toContain('{"event":"notify.send_failed","code":"timeout"}');
    expect((await stamps(id)).notified_at).toBeNull();
    expect(await run()).toMatchObject({ sent: 1 });
    expect(sentTo(emails).length).toBe(1);
  });

  it("an account with no owner or admin gets no email and one fixed line; the ask stays unstamped", async () => {
    const { refs } = await account(["member"]);
    const id = await ask(refs);
    await run();
    expect(lines.filter((l) => l.includes("notify.no_recipients"))).toEqual(['{"event":"notify.no_recipients","accounts":1}']);
    expect((await stamps(id)).notified_at).toBeNull();
  });

  it("the captured request never carries question or option text, an id, or a name: fixed copy, a count and the app link", async () => {
    const { refs, emails } = await account();
    const id = await ask(refs);
    await run();
    const body = fake.requests.map((r) => r.body).join("\n");
    expect(body).not.toContain(MARK);
    expect(body).not.toContain(id);
    expect(body).not.toContain(refs.accountId);
    expect(sentTo(emails)[0]!.text).toContain("Open Needs you to answer: https://app.example");
    expect(lines.join("\n")).not.toMatch(/@example\.test|re_test_key/);
  });

  it("runAskWindowTick calls it (after the sweep) and a failing transport never fails the tick", async () => {
    const { refs, emails } = await account();
    await ask(refs);
    await runAskWindowTick({ pool: receiptPool, warn: (l) => lines.push(l), notify: { env: ENV, makeTransport } });
    expect(sentTo(emails).length).toBe(1);
    const broken = await account();
    await ask(broken.refs);
    await expect(runAskWindowTick({ pool: receiptPool, warn: (l) => lines.push(l), notify: { env: ENV, makeTransport: () => { throw new Error("boom"); } } })).resolves.toHaveProperty("nextAskDueAt");
  });
});
