import type { Pool, PoolClient } from "pg";
import { evaluateRules, platformAskRequest, tightenAskDisposition, usdCeilCents, type PresetName } from "@fx/decisions";
import { resolveActionRules } from "@fx/db/src/actionRules.js";
import { getCurrentDialSetting } from "@fx/db/src/decisions.js";
import { writeReceipt } from "@fx/db/src/receiptWriter.js";
import { attachStartGate, claimStartGate, writeStartReceipt } from "@fx/db/src/startGate.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { resolveStart, type StartCategory, type StartInput } from "@fx/core/src/autonomy/resolveStart.js";
import { cleanWorkItemTitle } from "@fx/core/src/work-items/title.js";
import { childGateOutcomeOfError, gateChildLaunch, type ChildGateOutcome, type ChildLaunchCode, type ChildLaunchDeps } from "@fx/core/src/decisions/childLaunch.js";
import { autostartRoom, weekStartUtc } from "@fx/spend";
import { reportError } from "@fx/telemetry";
import { markWorkPending } from "@fx/core/src/pendingWork.js";

/**
 * D#483 S5-b1a-2 (also D#7 R1b): the auto-start sweep. A verified proposal of a small, bug or doc item starts with no click, only while ALL of these hold:
 *
 *  - the repo's dial for that start type is `act` or `announce` (an `ask` row, an unknown disposition or NO row asks: the definer needs a dial version to name,
 *    and "no row" has no version; the catalogue default is ask);
 *  - `resolveStart` says go with the proposal's REAL facts (this sweep is unattended, so the hard rules apply: the repo's own loop, outside text, no check, an
 *    unknown category, the free preview, no write install). The proposal's category is the discovery hint; a feature, project, critical or unknown one asks;
 *  - the customer's approval rules, which here can only tighten: a matching `deny` or `ask` rule stops the start, an `approve` rule changes nothing, and a rule set
 *    that cannot be read asks (`tightenAskDisposition`);
 *  - the confirmed weekly auto-start limit has room for one more first run (`autostartRoom`), decided UNDER the envelope's lock in the SAME transaction as the start.
 *
 * Then, in that one transaction on the receipt login (no person, no token: the actor is `policy`): the work item, the class-2 receipt anchored on the verifier run,
 * `approve_proposal_by_dial` (0901: re-checks the hard rules, attaches the weekly envelope) and `run_action_request_by_dial` (files the start). Any refusal rolls
 * all of it back. A replay finds the proposal no longer `new` and writes nothing. Nothing here is a person's click: `personFiled` and the stage driver's
 * `person_click` origin are never set by this file.
 *
 * D#483 S5-b2c-1: after the proposals, in the same pass and the same time budget, a child pass looks at the planned PR children that wait to be launched
 * (`planned_pr_child_list_due`; an orphan is never listed). Each child is one transaction on the same login: the launch rule (the database's `planned_pr_child_blocker`,
 * which the definer `dial_launch_child` runs again), the repo's `launch_sub_item` dial, the parent's envelope, then the keyed policy receipt and the definer, or one
 * ask per (parent, key). A start it files is keyed `dial:<receipt>`, so the driver reads it as the dial's (`dialFiled`) and never a person's click. Until the build
 * supports a child (`CHILD_BUILD_SUPPORTED`, injected as `child.buildSupported`) the pass derives every reason and files nothing.
 *
 * Every number and state that is unknown fails closed to "no start". The proposal stays `new`, and the Inbox says why (the off sentence, or the person's own
 * Approve). Writes happen only inside the gate transaction, so a pass that stops half way leaves nothing half done.
 */

export const AUTOSTART_LIST_PAGE = 50;
/** A pass stops starting proposals after this long, leaving the rest to the next tick. */
export const AUTOSTART_PASS_BUDGET_MS = 40_000;

const SMALL = ["small", "bug", "doc"] as const;
type SmallKind = (typeof SMALL)[number];
const PRESET_OF_DISPOSITION: Readonly<Record<string, PresetName>> = { ask: "cautious", announce: "balanced", act: "autonomous" };
/** The definer's refusals (SQLSTATE 55000, the code as the message) that mean "not this one", not a fault. `not_new` is a replay. */
const DEFINER_REFUSALS = new Set([
  "account_not_active", "dial_withdrawn", "owned_by_internal_loop", "external_needs_approval", "not_checked", "repo_not_connected", "receipt_wrong_anchor",
  "dial_not_open", "autostart_off", "autostart_confirmer_not_admin", "envelope_already_set", "work_started", "work_item_wrong_stage",
]);

export interface AutoStartCounts {
  listed: number;
  started: number;
  /** Left waiting for a person: the dial, a rule, a hard rule or the item's kind says ask. */
  asked: number;
  /** A customer rule said not to start it. */
  held_by_rule: number;
  /** The weekly limit has no room for another first run. */
  no_room: number;
  /** Not startable now (no dial row, a refusal at the data, nothing to price). */
  not_ready: number;
  /** Another pass or a person got there first. */
  replayed: number;
  failed: number;
  idle?: "not_configured";
  /** D#483 S5-b2c-1: the child pass (absent when the proposal pass used the whole time budget). */
  children?: ChildPassCounts;
  /** When some proposal waits only for room: the Monday 00:00 UTC the weekly limit renews. */
  renews_at?: string;
}
export type AutoStartOutcome = "started" | "asked" | "held_by_rule" | "no_room" | "not_ready" | "replayed";

/** The child pass's counts. `held` says why, by the section 2 code, for the children a rule held or an envelope had no room for. */
export interface ChildPassCounts {
  listed: number;
  started: number;
  asked: number;
  held_by_rule: number;
  no_room: number;
  not_ready: number;
  replayed: number;
  failed: number;
  held: Partial<Record<ChildLaunchCode, number>>;
}
export const AUTOSTART_CHILD_LIST_PAGE = 50;

export interface AutoStartDeps {
  /** The RECEIPT login's pool: the only login that can call the list and the two dial definers. */
  receiptPool: Pool;
  /** The price of an item's first run (pipeline's `firstRunReservationUsd`; this package cannot import @fx/pipeline). Must run inside the given tenant client. */
  firstRunUsd(client: PoolClient, input: { accountId: string; repoId: string }): Promise<number>;
  /** D#483 S5-b2c-1: the child pass's outside pieces (pipeline's `CHILD_BUILD_SUPPORTED` and the parent envelope's room for p(executor)). Absent, the child pass files nothing (`not_ready`). */
  child?: ChildLaunchDeps;
  now?(): Date;
  warn?(line: string): void;
}

export interface Facts {
  id: string; repo_id: string; state: string; title: string | null; gh_number: number | null; owner_process: string; provenance: string; verification: string;
  verified_run_id: string | null; category_hint: string | null; verifier_category: string | null; dial_withdrawn_at: Date | null; account_status: string | null; connected: boolean; owner: string | null; name: string | null;
}

const FACTS_SQL = `SELECT p.id, p.repo_id, p.state, p.title, p.gh_number, p.owner_process, p.provenance, p.verification, p.verified_run_id, p.category_hint, p.verifier_category, p.dial_withdrawn_at,
       a.status AS account_status, (r.installation_id IS NOT NULL) AS connected, r.gh_owner AS owner, r.gh_name AS name
  FROM proposals p
  LEFT JOIN accounts a ON a.id = p.account_id
  LEFT JOIN repos r ON r.account_id = p.account_id AND r.id = p.repo_id
 WHERE p.account_id = $1::uuid AND p.id = $2::uuid`;

const smallKind = (hint: string | null): SmallKind | null => (SMALL as readonly string[]).includes(hint ?? "") ? (hint as SmallKind) : null;

/**
 * D#483 S5-b1a-3: the proposal's category for the gate: the verifier's stored category, else the discovery hint. The verifier's category counts ONLY for an
 * internal proposal that names a verified run; for any other proposal it is not read at all (an external one asks whatever the model said, and `resolveStart`
 * refuses it a second time). The model's word is never trusted beyond the fixed kinds: whatever it is, only small, bug and doc can start (`smallKind`).
 */
export function gateCategory(p: Pick<Facts, "provenance" | "verified_run_id" | "verifier_category" | "category_hint">): string | null {
  const trusted = p.provenance === "internal" && p.verified_run_id !== null && p.verifier_category !== null;
  return trusted ? p.verifier_category : p.category_hint;
}

async function gateOne(deps: AutoStartDeps, client: PoolClient, accountId: string, proposalId: string): Promise<AutoStartOutcome> {
  const p = (await client.query<Facts>(FACTS_SQL, [accountId, proposalId])).rows[0];
  if (p === undefined || p.state !== "new") return "replayed";
  // A person withdrew an earlier dial approval of this proposal: only a person approves it again (the lister and the definer say the same).
  if (p.dial_withdrawn_at !== null) return "not_ready";
  const kind = smallKind(gateCategory(p));
  if (kind === null || p.verified_run_id === null) return resolveStart(startInput(p, "cautious")).outcome === "refused" ? "not_ready" : "asked";
  const decisionType = `start_work_${kind}` as const;
  // The dial: only a row that was written starts anything. An unknown disposition reads as Cautious.
  const dial = await getCurrentDialSetting(client, p.repo_id, decisionType);
  if (dial === null) return "not_ready";
  const resolved = resolveStart(startInput(p, PRESET_OF_DISPOSITION[dial.disposition] ?? "cautious"));
  if (resolved.outcome === "refused") return "not_ready";
  if (resolved.outcome !== "act" && resolved.outcome !== "announce") return "asked";

  // The weekly limit, under the envelope's lock; the start below is in this same transaction.
  const firstRunUsd = await deps.firstRunUsd(client, { accountId, repoId: p.repo_id });
  const room = await autostartRoom(client, { accountId, firstRunUsd, ...(deps.now ? { now: deps.now() } : {}) });
  // The lock may have been waited for: another pass or a person may have decided this proposal meanwhile, so its state is read again, now.
  const fresh = (await client.query<{ state: string }>("SELECT state FROM proposals WHERE account_id = $1::uuid AND id = $2::uuid", [accountId, proposalId])).rows[0];
  if (fresh?.state !== "new") return "replayed";
  if (!room.fits) return room.reason === "exhausted" ? "no_room" : "not_ready";

  // The customer's rules may only make this stricter. A rule that matched decides; a set that could not be read (a reason with no rule) asks; no match changes nothing.
  const rules = await resolveActionRules(client, p.repo_id);
  const facts = { repo: p.owner && p.name ? `${p.owner}/${p.name}` : "", category: kind, remaining_usd: usdCeilCents(room.remainingUsd), first_run_usd: usdCeilCents(firstRunUsd) };
  const verdict = evaluateRules(rules.rules, platformAskRequest(decisionType), facts);
  const ruleOutcome = verdict.ruleId !== null || verdict.reason !== undefined ? verdict.outcome : "approve";
  const final = tightenAskDisposition(decisionType, resolved.outcome, ruleOutcome);
  if (final === "deny") return "held_by_rule";
  if (final !== "act" && final !== "announce") return "asked";

  // A work item already open for this issue is somebody's: the dial does not take it over.
  if (p.gh_number !== null) {
    const open = await client.query(`SELECT 1 FROM work_items WHERE account_id = $1::uuid AND repo_id = $2::uuid AND gh_number = $3 AND stage <> 'closed' LIMIT 1`, [accountId, p.repo_id, p.gh_number]);
    if (open.rows.length > 0) return "not_ready";
  }
  const title = cleanWorkItemTitle(p.title);
  if (title === null) return "not_ready";
  const item = await client.query<{ id: string }>(
    `INSERT INTO work_items (account_id, repo_id, kind, gh_number, provenance, title) VALUES ($1::uuid, $2::uuid, 'issue', $3, 'internal', $4) RETURNING id`,
    [accountId, p.repo_id, p.gh_number, title],
  );
  const workItemId = item.rows[0]!.id;
  const receipt = await writeReceipt(client, {
    class: "human_over_the_loop",
    runId: p.verified_run_id,
    workItemId,
    decisionType,
    chosen: "start",
    rejectedAlternative: "wait_for_approval",
    dialVersion: dial.version,
    quotedInputs: [{ trust: "trusted", storedBody: p.verification }],
    ...(rules.version > 0 ? { ruleSetVersion: rules.version } : {}),
  });
  if (receipt.store !== "decision_receipts") throw new Error("auto-start receipt was not durable");
  // The item's one start decision, for its card ("Started automatically under your ... setting") and for the stage driver: a `started` row decided by the
  // dial (`policy`). It exists before the driver's first look at the item, so a later person-filed advance finds it started and records no receipt of its own.
  const preset = PRESET_OF_DISPOSITION[dial.disposition] ?? "cautious";
  const gateRow = await claimStartGate(client, { workItemId, decisionType, preset, dialVersion: dial.version, outcome: "started" });
  if (!gateRow.claimed) throw new Error("auto-start gate row already existed for a new work item");
  await attachStartGate(client, { gateId: gateRow.id, receiptId: await writeStartReceipt(client, { workItemId, decisionType, chosen: "start", dialVersion: dial.version }) });
  await client.query("SELECT * FROM approve_proposal_by_dial($1::uuid, $2::uuid, $3::uuid)", [proposalId, workItemId, receipt.id]);
  await client.query("SELECT * FROM run_action_request_by_dial($1::uuid, $2::uuid)", [workItemId, receipt.id]);
  return "started";
}

function startInput(p: Facts, preset: PresetName): StartInput {
  const hint = gateCategory(p);
  return {
    preset,
    ownerProcess: p.owner_process as StartInput["ownerProcess"],
    // Discovery stores the loop-repo fact as the proposal's owner (decideOwnerProcess), which the line above already reads.
    engineLoopRepo: false,
    provenance: p.provenance as StartInput["provenance"],
    verification: p.verification as StartInput["verification"],
    category: hint as StartCategory | null,
    freePreview: p.account_status !== "active",
    hasWriteInstall: p.connected === true,
  };
}

export function createAutoStartSweep(deps: AutoStartDeps) {
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const now = deps.now ?? (() => new Date());

  /** One proposal through the gate, in one transaction. The sweep calls it for what the lister names; tests call it for rows the lister would never name. */
  async function gateProposal(accountId: string, proposalId: string): Promise<AutoStartOutcome> {
    try {
      return await withTenant(deps.receiptPool, accountId, (client) => gateOne(deps, client, accountId, proposalId));
    } catch (err) {
      const e = err as { code?: string; message?: string } | null;
      // The definers' fixed refusals leave nothing behind (the whole transaction rolled back); a replay is `not_new` or a used work item or receipt.
      if (e?.code === "55000" && e.message === "not_new") return "replayed";
      if (e?.code === "23505") return "replayed";
      if (e?.code === "42501" || (e?.code === "55000" && DEFINER_REFUSALS.has(e.message ?? ""))) return "not_ready";
      throw err;
    }
  }

  /** One planned PR child through the dial, in one transaction. Tests call it for children the lister would not name. */
  async function gateChild(accountId: string, childId: string): Promise<{ outcome: ChildGateOutcome; code?: ChildLaunchCode }> {
    try {
      return await withTenant(deps.receiptPool, accountId, (client) => gateChildLaunch(client, { accountId, childId, deps: deps.child }));
    } catch (err) { // fx-swallow-ok: a definer's fixed refusal is an outcome (rolled back, nothing left); anything else is rethrown by childGateOutcomeOfError
      // The definers' fixed refusals leave nothing behind (the whole transaction rolled back); anything else is a fault and is rethrown. A refusal that means
      // "not ready" is logged as a fixed line (its SQLSTATE and the definer's fixed code, never a value), so a missing grant shows up.
      const result = childGateOutcomeOfError(err);
      if (result.outcome === "not_ready") warn(JSON.stringify({ event: "auto_start.child_refused", sqlstate: (err as { code?: string } | null)?.code ?? null, reason: (err as { message?: string } | null)?.message?.slice(0, 64) ?? null }));
      return result;
    }
  }

  async function sweepChildren(counts: AutoStartCounts, startedAt: number): Promise<void> {
    const c: ChildPassCounts = { listed: 0, started: 0, asked: 0, held_by_rule: 0, no_room: 0, not_ready: 0, replayed: 0, failed: 0, held: {} };
    counts.children = c;
    let after: [string | null, string | null] = [null, null];
    for (;;) {
      const { rows } = await deps.receiptPool.query<{ account_id: string; child_id: string; created_at: Date }>("SELECT account_id, child_id, created_at FROM planned_pr_child_list_due($1::integer, $2::timestamptz, $3::uuid)", [AUTOSTART_CHILD_LIST_PAGE, ...after]);
      for (const r of rows) {
        c.listed += 1;
        if (now().getTime() - startedAt > AUTOSTART_PASS_BUDGET_MS) return;
        try {
          const res = await gateChild(r.account_id, r.child_id);
          c[res.outcome] += 1;
          if (res.code !== undefined) c.held[res.code] = (c.held[res.code] ?? 0) + 1;
        } catch (err) {
          // One child that cannot be gated never holds up the rest; it is listed again next pass.
          reportError(err, { stage: "auto_start.child" });
          warn(JSON.stringify({ event: "auto_start.child_failed" }));
          c.failed += 1;
        }
      }
      if (rows.length < AUTOSTART_CHILD_LIST_PAGE) return;
      const last = rows[rows.length - 1]!;
      after = [last.created_at.toISOString(), last.child_id];
    }
  }

  async function sweepAutoStart(): Promise<AutoStartCounts> {
    const counts: AutoStartCounts = { listed: 0, started: 0, asked: 0, held_by_rule: 0, no_room: 0, not_ready: 0, replayed: 0, failed: 0 };
    const startedAt = now().getTime();
    const full = new Set<string>();
    let after: [string | null, string | null] = [null, null];
    // Every page is read until a short one comes back or the pass budget runs out: a fixed number of pages would let one account's old rows that always
    // ask keep every later account out of reach. (No cursor is kept between passes: the cron is stateless, and the budget bounds the work.)
    for (;;) {
      const { rows } = await deps.receiptPool.query<{ account_id: string; proposal_id: string; verified_at: Date }>("SELECT account_id, proposal_id, verified_at FROM proposal_gate_list_due($1::integer, $2::timestamptz, $3::uuid)", [AUTOSTART_LIST_PAGE, ...after]);
      for (const r of rows) {
        counts.listed += 1;
        if (now().getTime() - startedAt > AUTOSTART_PASS_BUDGET_MS) return finish(counts);
        // An account whose limit has no room has none for the rest of this pass either.
        if (full.has(r.account_id)) { counts.no_room += 1; continue; }
        try {
          const outcome = await gateProposal(r.account_id, r.proposal_id);
          counts[outcome] += 1;
          if (outcome === "no_room") full.add(r.account_id);
        } catch (err) {
          // One proposal that cannot be gated never holds up the rest; it is listed again next pass.
          reportError(err, { stage: "auto_start.item" });
          warn(JSON.stringify({ event: "auto_start.item_failed" }));
          counts.failed += 1;
        }
      }
      if (rows.length < AUTOSTART_LIST_PAGE) break;
      const last = rows[rows.length - 1]!;
      after = [last.verified_at.toISOString(), last.proposal_id];
    }
    await sweepChildren(counts, startedAt);
    return finish(counts);
  }

  function finish(counts: AutoStartCounts): AutoStartCounts {
    // A start the dial filed is an advance request row written by a definer, which sends no kick: without the marker the gated run-action cron would leave it
    // for its half-hour backstop.
    if (counts.started > 0 || (counts.children?.started ?? 0) > 0) void markWorkPending("run-action-sweep");
    if (counts.no_room > 0) counts.renews_at = new Date(weekStartUtc(now()).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    return counts;
  }

  return { sweepAutoStart, gateProposal, gateChild };
}
