import { runAfterReceipt, type AfterReceiptHook } from "@fx/core/src/decisions/receiptHook.js";
import type { Pool, PoolClient } from "pg";
import { PRESETS, getCatalogueEntry, type CatalogueEntry, type PresetName, type TimeoutOutcome } from "@fx/decisions";
import { FIXED_INVARIANT_KEYS } from "@fx/db/src/dialInventory.js";
import { getDialSettingAt, type DecisionSetting } from "@fx/db/src/decisions.js";
import { AskRaiseError, type AskPolicy } from "@fx/db/src/decisionAsks.js";
import { raiseAskMarked } from "@fx/core/src/decisions/raiseAskMarked.js";
import { resolveAskPolicyForWorkItem } from "@fx/db/src/decisionAskSettings.js";
import { ReceiptWriteError, writeReceipt } from "@fx/db/src/receiptWriter.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { parseDecisionRequestField, parseDecisionsTakenField, type DecisionOption } from "@fx/roles/decision-request";
import { recordDecisionIdsEvent, recordDecisionRefusedEvent, type DecisionRefusalCode } from "@fx/runner";
import { sanitize } from "@fx/trust";
import { DecisionSnapshotInvalidError, NO_DIAL_ROW_PRESET, SNAPSHOT_KEY_PATTERN, declaredDecisionTypes, dispositionForDial, readDecisionSnapshot } from "./decisionSnapshot.js";

/**
 * D#7 DP4b-2 (correction DP-C11, R-7-DP4b-2, -4, -7, -8): the call site. After an executor run ends `succeeded`, the workflow asks this once; it reads the
 * run's two decision fields (`decision_request`, "I stopped to ask", and `decisions_taken`, "I decided and report it") through the run's own snapshot and
 * does the one thing each means. An agent only proposes: every effect here is a receipt, an ask for a person, or a refusal row. The four fixed invariants
 * are never touched (a request that names one is refused); nothing from this file reaches the layers that enforce them.
 *
 * Three phases, each atomic, and a replay of the step writes nothing twice:
 *   1. plan   (runner login, read only): halt, the run, the snapshot, each entry checked in R-7-DP4b-4's order. Pure data out.
 *   2. effect (RECEIPT login, one transaction under a lock on the run): receipts, then asks. Skipped when the run's receipts or asks already exist.
 *   3. events (runner login, one transaction): refusal rows, `decision.announced`, `decision.ask_raised`, and last a `decision.intake` marker that makes a
 *      replay skip this phase.
 * The step returns one fixed word, never model text.
 */
export type DecisionStepCode = "none" | "resolved" | "parked" | "refused" | "item_halted" | "halted_since_approval";

export interface DecisionStepInput {
  accountId: string;
  workItemId: string;
  haltEpoch: number;
  runId: string;
}
export type DecisionIntake = (input: DecisionStepInput) => Promise<DecisionStepCode>;

export interface DecisionIntakeDeps {
  /** The runner login's pool: reads, and the run's event rows. Never a receipt. */
  runnerPool: Pool;
  /** The receipt login's pool: the only pool a receipt or an ask is written on. */
  receiptPool: Pool;
  /** Test seam: the decision types a role declares. Defaults to the role's card. */
  declared?: (role: string) => readonly string[];
  /** Test seam: runs between phase 1 and phase 2, where a halt can land. */
  afterPlan?: () => Promise<void>;
  /** D#7 DP6a-WIRING: told after the receipts have committed, so the receipt block on the item's pull request is refreshed. Best-effort, never throws. */
  afterReceipt?: AfterReceiptHook;
}

interface Refusal {
  code: DecisionRefusalCode;
  key?: string;
}
interface PlannedReceipt {
  entry: CatalogueEntry;
  key: string;
  chosen: string;
  rejected: string;
  dialVersion: number;
  rationale: string;
  announce: boolean;
}
interface PlannedAsk {
  entry: CatalogueEntry;
  key: string;
  options: DecisionOption[];
  proposed: string;
  rationale: string;
  preset: PresetName;
}
interface Plan {
  refusals: Refusal[];
  receipts: PlannedReceipt[];
  asks: PlannedAsk[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRESET_NAMES: readonly string[] = PRESETS.map((p) => p.name);

/** The timeout tuple a park freezes (R-7-DP4b-8): the settings-resolved tuple, clamped again to what the entry allows. Never `proceed_recommended` where the entry excludes it. */
export function askPolicyFor(entry: CatalogueEntry, resolved: { answerWindowMinutes: number; timeoutOutcome: TimeoutOutcome }): AskPolicy {
  const proceed = resolved.timeoutOutcome === "proceed_recommended" && entry.timeoutOutcomes.includes("proceed_recommended");
  return { answerWindowMinutes: resolved.answerWindowMinutes, onTimeout: proceed ? "proceed_recommended" : "stop_and_flag" };
}

/**
 * The preset an ask's timing starts from. A type with no dial row follows the same default as its disposition (`NO_DIAL_ROW_PRESET`, owner ruling 2026-10-25);
 * a row that adopted a preset uses it; a per-type override row (no preset) stays Cautious, the strictest timing.
 */
export function askPresetOf(row: { preset: string | null } | null): PresetName {
  if (row === null) return NO_DIAL_ROW_PRESET;
  return PRESET_NAMES.includes(row.preset ?? "") ? (row.preset as PresetName) : "cautious";
}

const asObject = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const dialOf = (row: DecisionSetting | null) => (row === null ? null : { version: row.version, disposition: row.disposition, preset: row.preset });

export function createDecisionIntake(deps: DecisionIntakeDeps): DecisionIntake {
  const declaredOf = deps.declared ?? declaredDecisionTypes;

  /** Phase 1. Throws only on a database failure; every other fault is a refusal in the plan. */
  async function plan(client: PoolClient, input: DecisionStepInput): Promise<DecisionStepCode | Plan> {
    const { accountId, workItemId, runId } = input;
    const item = (await client.query<{ repo_id: string | null; halted: boolean; halt_epoch: number }>("SELECT repo_id, halted_at IS NOT NULL AS halted, halt_epoch FROM work_items WHERE id = $1 AND account_id = $2", [workItemId, accountId])).rows[0];
    if (!item) return "none";
    if (item.halted) return "item_halted";
    if (item.halt_epoch !== input.haltEpoch) return "halted_since_approval";
    const run = (await client.query<{ role: string; status: string; work_item_id: string | null; envelope: unknown }>("SELECT role, status, work_item_id, envelope FROM agent_runs WHERE id = $1 AND account_id = $2", [runId, accountId])).rows[0];
    // Only an executor declares decisions: any other role's run is never read.
    if (!run || run.work_item_id !== workItemId || run.role !== "executor") return "none";
    const envelope = asObject(run.envelope);
    if (envelope === null) return "none";
    const rawRequest = envelope.decision_request ?? null;
    const rawTaken = envelope.decisions_taken ?? null;
    if (rawRequest === null && rawTaken === null) return "none";

    const out: Plan = { refusals: [], receipts: [], asks: [] };
    const refuse = (code: DecisionRefusalCode, key?: string) => out.refusals.push({ code, ...(key === undefined ? {} : { key }) });
    if (run.status !== "succeeded") {
      refuse("run_not_succeeded");
      return out;
    }
    const request = parseDecisionRequestField(rawRequest);
    const taken = parseDecisionsTakenField(rawTaken);
    if (!request.ok || !taken.ok) {
      refuse("decision_fields_malformed");
      return out;
    }

    let snapshot;
    try {
      snapshot = await readDecisionSnapshot(client, runId);
    } catch (err) {
      if (!(err instanceof DecisionSnapshotInvalidError)) throw err;
      snapshot = null; // a snapshot that fails its own schema is no snapshot: fail closed
    }
    const entries = [
      ...(request.value === null ? [] : [{ kind: "request" as const, v: request.value }]),
      ...(taken.value ?? []).map((v) => ({ kind: "taken" as const, v })),
    ];
    if (snapshot === null) {
      entries.forEach(() => refuse("decision_snapshot_missing"));
      return out;
    }
    const declared = new Set(declaredOf(run.role));
    const askedTypes = new Set<string>();
    for (const e of entries) {
      const word = e.v.type;
      const key = SNAPSHOT_KEY_PATTERN.test(word) ? word : undefined;
      if (FIXED_INVARIANT_KEYS.includes(word)) {
        refuse("invariant_named");
        continue;
      }
      const snap = snapshot.entries.find((s) => s.key === word);
      if (!snap) {
        refuse("decision_key_unknown", key);
        continue;
      }
      const entry = getCatalogueEntry(snap.decision_type);
      if (!entry || !declared.has(snap.decision_type)) {
        refuse("decision_type_not_declared", key);
        continue;
      }
      // The tamper check: the disposition is recomputed from the dial row at the snapshot's version and must equal what was frozen at spawn.
      const dial = snap.dial_version > 0 && item.repo_id !== null ? await getDialSettingAt(client, item.repo_id, snap.decision_type, snap.dial_version) : null;
      if ((snap.dial_version > 0 && dial === null) || dispositionForDial(entry, dialOf(dial)) !== snap.disposition) {
        refuse("decision_snapshot_mismatch", key);
        continue;
      }
      const chosen = e.kind === "request" ? e.v.proposed : e.v.chosen;
      const decideYourself = snap.disposition !== "ask";
      if (decideYourself) {
        const rejected = e.v.options.find((o) => o.id !== chosen)?.id ?? chosen;
        out.receipts.push({ entry, key: snap.key, chosen, rejected, dialVersion: snap.dial_version, rationale: e.v.rationale, announce: snap.disposition === "announce" });
        continue;
      }
      // A "stop and ask" key. A request is what it should be; a decision taken on it overstepped, and what the agent chose is only a proposal.
      if (e.kind === "taken") refuse("decided_without_asking", key);
      if (askedTypes.has(snap.decision_type)) continue;
      askedTypes.add(snap.decision_type);
      const preset = askPresetOf(dial);
      out.asks.push({ entry, key: snap.key, options: e.v.options, proposed: chosen, rationale: e.v.rationale, preset });
    }
    return out;
  }

  /**
   * Phase 2. All or nothing; the ids of the asks (new, or already there on a replay) by decision type. The replay test counts only this step's own facts: an
   * ask for one of the plan's types on this run, or a receipt of one of the plan's types on this run. A receipt another writer put on the run (the runner
   * auto-approve writes a class-2 `runner_run_on_member_plan` one with actor policy) is not this step's work and never makes it skip. A halt that landed
   * since phase 1 is re-read under the run's lock, before anything is written. (The receipt login cannot take a row lock on the item, so a halt landing
   * in the last instant before the commit is the sweep's: it withdraws the ask as `item_halted`.)
   */
  async function effects(input: DecisionStepInput, p: Plan): Promise<Map<string, string> | "item_halted" | "halted_since_approval"> {
    const { accountId, workItemId, runId } = input;
    return withTenant(deps.receiptPool, accountId, async (client) => {
      const ids = new Map<string, string>();
      if (p.receipts.length === 0 && p.asks.length === 0) return ids;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${accountId}:decision_intake:${runId}`]);
      const halt = await withTenant(deps.runnerPool, accountId, async (c) => (await c.query<{ halted: boolean; halt_epoch: number }>("SELECT halted_at IS NOT NULL AS halted, halt_epoch FROM work_items WHERE id = $1 AND account_id = $2", [workItemId, accountId])).rows[0]);
      if (!halt) return "item_halted";
      if (halt.halted) return "item_halted";
      if (halt.halt_epoch !== input.haltEpoch) return "halted_since_approval";
      const askTypes = p.asks.map((a) => a.entry.id);
      const existing = await client.query<{ id: string; decision_type: string }>("SELECT id, decision_type FROM decision_asks WHERE run_id = $1 AND decision_type = ANY($2::text[])", [runId, askTypes]);
      const class2Types = p.receipts.filter((r) => r.entry.class !== "automated_with_monitoring").map((r) => r.entry.id);
      const class1Types = p.receipts.filter((r) => r.entry.class === "automated_with_monitoring").map((r) => r.entry.id);
      const applied =
        existing.rows.length > 0 ||
        (class2Types.length > 0 && (await client.query("SELECT 1 FROM decision_receipts WHERE run_id = $1 AND decision_type = ANY($2::text[]) LIMIT 1", [runId, class2Types])).rows.length > 0) ||
        // Class-1 receipts are run_events rows only the receipt definer can write, readable with their type on the runner login (the write above holds the lock).
        (class1Types.length > 0 &&
          (await withTenant(deps.runnerPool, accountId, (c) => c.query("SELECT 1 FROM run_events WHERE run_id = $1 AND kind = 'decision_receipt' AND payload->>'decision_type' = ANY($2::text[]) LIMIT 1", [runId, class1Types]))).rows.length > 0);
      if (applied) {
        for (const r of existing.rows) ids.set(r.decision_type, r.id);
        return ids;
      }
      for (const r of p.receipts) {
        await writeReceipt(client, { class: r.entry.class, runId, workItemId, decisionType: r.entry.id, chosen: r.chosen, rejectedAlternative: r.rejected, dialVersion: r.dialVersion, quotedInputs: [{ trust: "untrusted", storedBody: sanitize(r.rationale) }] });
      }
      for (const a of p.asks) {
        const policy = askPolicyFor(a.entry, await resolveAskPolicyForWorkItem(client, { decisionType: a.entry.id, workItemId, preset: a.preset }));
        ids.set(a.entry.id, await raiseAskMarked(client, { class: a.entry.class, decisionType: a.entry.id, workItemId, runId, options: a.options, proposed: a.proposed, rationale: a.rationale, quotedInputs: [{ trust: "untrusted", storedBody: sanitize(a.rationale) }], policy }));
      }
      return ids;
    });
  }

  const codeOf = (p: Plan): DecisionStepCode => (p.asks.length > 0 ? "parked" : p.receipts.length > 0 ? "resolved" : "refused");

  /** Phase 3. One transaction; the marker row goes in last, so a replay finds either all of it or none. */
  async function events(input: DecisionStepInput, p: Plan, askIds: Map<string, string>): Promise<void> {
    const { accountId, runId } = input;
    await withTenant(deps.runnerPool, accountId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${accountId}:decision_events:${runId}`]);
      if ((await client.query("SELECT 1 FROM run_events WHERE run_id = $1 AND kind = 'decision.intake' LIMIT 1", [runId])).rows.length > 0) return;
      for (const r of p.refusals) await recordDecisionRefusedEvent(client, { accountId, runId, code: r.code, ...(r.key === undefined ? {} : { key: r.key }) });
      for (const r of p.receipts) if (r.announce) await recordDecisionIdsEvent(client, { accountId, runId, kind: "decision.announced", payload: { decision_type: r.entry.id, key: r.key } });
      for (const a of p.asks) await recordDecisionIdsEvent(client, { accountId, runId, kind: "decision.ask_raised", payload: { decision_type: a.entry.id, key: a.key, ask_id: askIds.get(a.entry.id) as string } });
      await recordDecisionIdsEvent(client, { accountId, runId, kind: "decision.intake", payload: { code: codeOf(p) } });
    });
  }

  return async (input) => {
    if (![input.accountId, input.workItemId, input.runId].every((id) => UUID_RE.test(id)) || !Number.isSafeInteger(input.haltEpoch)) return "none";
    const planned = await withTenant(deps.runnerPool, input.accountId, (client) => plan(client, input));
    if (typeof planned === "string") return planned;
    let p = planned;
    let askIds = new Map<string, string>();
    try {
      await deps.afterPlan?.();
      const done = await effects(input, p);
      if (typeof done === "string") return done;
      askIds = done;
      // Never park without a question to answer: an ask planned but missing an id throws, so the step retries and no `ask_raised` row carries an empty id.
      if (p.asks.some((a) => !askIds.has(a.entry.id))) throw new Error("decision_intake: a planned ask has no ask id");
    } catch (err) {
      // Agent data the ask or receipt definer refuses on shape: the request is dropped, as any other malformed one. A database failure still throws (the step retries).
      if (!(err instanceof AskRaiseError || err instanceof ReceiptWriteError)) throw err;
      p = { refusals: [...p.refusals, { code: "decision_fields_malformed" }], receipts: [], asks: [] };
    }
    // The receipts above are committed. A class-2 one reaches the item's pull request block now; the run's own events are written after, and a failure of the block changes nothing.
    if (p.receipts.some((r) => r.entry.class === "human_over_the_loop")) await runAfterReceipt(deps.afterReceipt, input.accountId, input.workItemId);
    await events(input, p, askIds);
    return codeOf(p);
  };
}
