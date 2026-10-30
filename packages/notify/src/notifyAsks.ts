import type { Pool } from "pg";
import { isAccountNotifyWindowOpen, listAccountNotifyRecipients, listAsksDueForNotify, stampAskNotified, stampAskRenotified, type AskNotifyDue } from "@fx/db/src/askNotify.js";
import { loadNotifyConfig } from "./config.js";
import { createResendTransport, type EmailMessage, type EmailTransport, type SendCode, type SendResult } from "./resend.js";
import { buildEmailText } from "./template.js";

/** One email per account per window. The window is read from the database (migration 0932), so concurrent or later invocations agree on it. */
export const NOTIFY_WINDOW_SECONDS = 15 * 60;
/** Resend takes at most 50 recipients on one message. */
const MAX_RECIPIENTS = 50;

export interface NotifyAsksDeps {
  /** The RECEIPT pool (app_user + receipt_writer_invoker): the only login that may call the notify definers. */
  pool: Pool;
  env?: Readonly<Record<string, string | undefined>>;
  warn: (line: string) => void;
  /** Test seam: builds the transport once the settings are known. The default is the Resend transport. */
  makeTransport?: (config: { apiKey: string }) => EmailTransport;
  windowSeconds?: number;
  /** Test seam for the hard bound on one send (default 10 s). */
  sendBoundMs?: number;
}

export interface NotifyAsksResult {
  /** Emails the provider accepted. */
  sent: number;
  /** Asks stamped (first email or reminder recorded). */
  stamped: number;
  failed: number;
  disabled: boolean;
}

const EMPTY: NotifyAsksResult = { sent: 0, stamped: 0, failed: 0, disabled: false };

/**
 * Sends the emails the ask sweep owes. Per account, inside one transaction holding a per-account advisory lock (so two overlapping ticks cannot both
 * send): the window is checked, the account's due asks go out as ONE email listing counts only, and only after the provider accepts is each ask stamped
 * through the compare-and-set definers. A provider failure rolls the transaction back, so nothing is stamped and the next tick sends once.
 * `proceed_recommended` asks are never emailed. With the key or sender unset nothing is sent or stamped and exactly one fixed line is written.
 * Never throws; lines carry counts and fixed codes only (no address, token, id or text).
 */
export async function notifyAsks(deps: NotifyAsksDeps): Promise<NotifyAsksResult> {
  const config = loadNotifyConfig(deps.env ?? process.env);
  if (!config.ok) {
    deps.warn(JSON.stringify({ event: "notify.email_disabled", reason: config.reason }));
    return { ...EMPTY, disabled: true };
  }
  const result = { ...EMPTY };
  try {
    const transport = (deps.makeTransport ?? createResendTransport)({ apiKey: config.apiKey });
    const due = (await listAsksDueForNotify(deps.pool, 500)).filter((d) => d.timeoutOutcome !== "proceed_recommended");
    const byAccount = new Map<string, AskNotifyDue[]>();
    for (const d of due) byAccount.set(d.accountId, [...(byAccount.get(d.accountId) ?? []), d]);
    let noRecipients = 0;
    for (const [accountId, asks] of byAccount) {
      const outcome = await notifyAccount(deps, transport, config, accountId, asks, result);
      if (outcome === "no_recipients") noRecipients += 1;
      if (outcome === "stop") break;
    }
    if (noRecipients > 0) deps.warn(JSON.stringify({ event: "notify.no_recipients", accounts: noRecipients }));
    if (result.sent > 0) deps.warn(JSON.stringify({ event: "notify.sent", emails: result.sent, asks: result.stamped }));
  } catch {
    // fx-swallow-ok: the tick must not fail on mail; the next tick tries again and nothing was stamped for the failed account
    result.failed += 1;
    deps.warn(JSON.stringify({ event: "notify.failed", code: "error" }));
  }
  return result;
}

type AccountOutcome = "done" | "skipped" | "no_recipients" | "stop";

async function notifyAccount(
  deps: NotifyAsksDeps,
  transport: EmailTransport,
  config: { from: string; appOrigin: string },
  accountId: string,
  asks: AskNotifyDue[],
  result: NotifyAsksResult,
): Promise<AccountOutcome> {
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok", [`notify-asks:${accountId}`]);
    if (lock.rows[0]?.ok !== true) return await end(client, "skipped");
    if (!(await isAccountNotifyWindowOpen(client, accountId, deps.windowSeconds ?? NOTIFY_WINDOW_SECONDS))) return await end(client, "skipped");
    const recipients = (await listAccountNotifyRecipients(client, accountId)).slice(0, MAX_RECIPIENTS);
    if (recipients.length === 0) return await end(client, "no_recipients");

    const first = asks.filter((a) => a.kind === "first");
    const reminders = asks.filter((a) => a.kind === "reminder");
    const text = buildEmailText({ appOrigin: config.appOrigin, first: first.length, reminder: reminders.length });
    const sent = await sendWithin(transport, deps.sendBoundMs ?? SEND_BOUND_MS, { from: config.from, to: recipients, subject: text.subject, text: text.text });
    if (!sent.ok && sent.code !== "rejected") {
      result.failed += 1;
      deps.warn(JSON.stringify({ event: "notify.send_failed", code: sent.code }));
      // A provider-wide condition (rate limit, bad key, blocked address): every other account would hit it too, so the tick ends here.
      return await end(client, retryWholeTick(sent.code) ? "stop" : "skipped");
    }
    if (!sent.ok) {
      // A 4xx the provider will not change its mind about (a malformed recipient, say): stamp so it is not retried forever, count it, say so once.
      result.failed += 1;
      deps.warn(JSON.stringify({ event: "notify.send_rejected", code: "rejected" }));
    } else {
      result.sent += 1;
    }
    for (const a of first) if (await stampAskNotified(client, a.askId)) result.stamped += 1;
    for (const a of reminders) if (await stampAskRenotified(client, a.askId)) result.stamped += 1;
    await client.query("COMMIT");
    return "done";
  } catch {
    // fx-swallow-ok: rolled back below; the failure is counted and one fixed line is written, the next tick retries
    await client.query("ROLLBACK").catch(() => undefined);
    result.failed += 1;
    deps.warn(JSON.stringify({ event: "notify.failed", code: "error" }));
    return "skipped";
  } finally {
    client.release();
  }
}

/** The hard bound on holding the account's transaction open for the provider call. */
export const SEND_BOUND_MS = 10_000;

async function sendWithin(transport: EmailTransport, boundMs: number, message: EmailMessage): Promise<SendResult> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<SendResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, code: "timeout" }), boundMs);
  });
  try {
    return await Promise.race([transport.send(message), bound]);
  } finally {
    clearTimeout(timer);
  }
}

const retryWholeTick = (code: SendCode): boolean => code === "rate_limited" || code === "auth" || code === "blocked";

async function end(client: { query: (sql: string) => Promise<unknown> }, outcome: AccountOutcome): Promise<AccountOutcome> {
  await client.query("ROLLBACK");
  return outcome;
}
