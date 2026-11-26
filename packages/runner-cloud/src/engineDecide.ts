import { EngineDecideReply, EngineDecideRequest } from "@fulcrumaxe/runner-protocol";
import { CATALOGUE_VERSION, resolveEngineDecision, type Disposition, type EngineDecisionType } from "@fx/decisions";
import { writeEngineAudit } from "@fx/db/src/engineAudit.js";
import { DIAL_DEFAULT_MARKER, getCurrentDialSetting } from "@fx/db/src/decisions.js";
import { clampForVisibility, type ClampVisibility } from "@fx/db/src/publicRepoClamp.js";
import type { PoolClient } from "pg";
import { readRepoVisibility } from "./repoPrivacy.js";
import { RunnerHttpError, asRunner, parseJsonBody, parseMessage, pgCode, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse } from "./http.js";
import { verifyRunnerRequest, withRunnerSession, type VerifiedRunner } from "./verifyRunnerRequest.js";

export const ENGINE_DECIDE_PATH = "/api/runner/engine/decide";

/**
 * The protocol's own strict schema (unknown keys at any level, wrong types and values outside their patterns are a 400), plus one rule it
 * leaves open: a `tag` means something only for a Spec, so on a spawn or a merge it is refused rather than ignored.
 */
export function parseEngineDecide(raw: unknown): EngineDecideRequest {
  const message = parseMessage(EngineDecideRequest, raw);
  if (message.subject.tag !== undefined && message.decision_type !== "engine_spec_ready") {
    throw new RunnerHttpError(400, "invalid_message", "the message does not match the protocol");
  }
  return message.command_id === undefined ? message : { ...message, command_id: message.command_id.toLowerCase() };
}

export type EngineGate = { repoId: string } | { refusal: "engine_bridge_off" | "engine_repo_not_enabled" | "operate_off" };

/** What the audit trail records for a decide: ids and enums only (the bridge's audit payload keys). */
export interface EngineDecideAuditEntry {
  action: "engine_decision.recorded";
  repoId: string;
  decisionType: EngineDecisionType;
  disposition: Disposition;
  commandId?: string;
}

/**
 * Everything the decide route reads outside its own table, and the audit writer. Each runs inside the one runner transaction. A port set
 * with no `audit` answers 503 before reading or writing anything: a decide that cannot be recorded must not be answered.
 */
export interface EngineDecidePorts {
  gate(client: PoolClient, input: { runnerId: string; repoGhId: number }): Promise<EngineGate>;
  /** The person who issued this `request_spawn` for exactly this repo, role and Discussion, when it is live; else null. */
  coveringCommand(client: PoolClient, input: { runnerId: string; repoId: string; commandId: string; role: string; discussion: number }): Promise<{ issuedBy: string } | null>;
  halted(client: PoolClient, repoId: string): Promise<boolean>;
  /** Writes the audit row on the same client. `actor` is the runner's registrant, the member the account's own audit trail names. */
  audit?: (client: PoolClient, entry: EngineDecideAuditEntry, actor: string) => Promise<void>;
}

/**
 * A runner has no member of its own, and `audit_write` names a verified member, so the row is written as the person who registered the
 * runner (the setting lasts for this transaction only). A registrant who has left the account makes the write, and so the decide, fail.
 */
async function pgAudit(client: PoolClient, entry: EngineDecideAuditEntry, actor: string): Promise<void> {
  await client.query("SELECT set_config('app.user_id', $1, true)", [actor]);
  await writeEngineAudit(client, entry.action, {
    repo_id: entry.repoId,
    decision_type: entry.decisionType,
    disposition: entry.disposition,
    ...(entry.commandId === undefined ? {} : { command_id: entry.commandId }),
  });
}

/** The database side, against the bridge tables (EB-4 settings and repos, EB-8a commands) and EB-11a's controls when that table exists. */
export const pgEngineDecidePorts: EngineDecidePorts = {
  audit: pgAudit,
  async gate(client, { runnerId, repoGhId }) {
    const { rows } = await client.query<{ repo_id: string; execution_mode: string; watch_enabled: boolean; operate_enabled: boolean; enabled: boolean; covered: boolean }>(
      `SELECT r.id AS repo_id, r.execution_mode, COALESCE(s.watch_enabled, false) AS watch_enabled, COALESCE(s.operate_enabled, false) AS operate_enabled,
              (b.repo_id IS NOT NULL) AS enabled, (r.id = ANY (rn.allowed_repo_ids)) AS covered
         FROM runners rn
         JOIN repos r ON r.account_id = rn.account_id AND r.gh_repo_id = $2
         LEFT JOIN engine_bridge_settings s ON s.account_id = r.account_id
         LEFT JOIN engine_bridge_repos b ON b.account_id = r.account_id AND b.repo_id = r.id
        WHERE rn.id = $1 AND rn.revoked_at IS NULL
        ORDER BY (r.id = ANY (rn.allowed_repo_ids)) DESC, (b.repo_id IS NOT NULL) DESC
        LIMIT 1`,
      [runnerId, repoGhId],
    );
    const row = rows[0];
    if (row === undefined) return { refusal: "engine_repo_not_enabled" };
    if (!row.watch_enabled) return { refusal: "engine_bridge_off" };
    if (!row.enabled || !row.covered || row.execution_mode !== "runner_local") return { refusal: "engine_repo_not_enabled" };
    if (!row.operate_enabled) return { refusal: "operate_off" };
    return { repoId: row.repo_id };
  },
  async coveringCommand(client, { runnerId, repoId, commandId, role, discussion }) {
    const { rows } = await client.query<{ issued_by: string }>(
      `SELECT c.issued_by FROM engine_commands c
        WHERE c.id = $1 AND c.runner_id = $2 AND c.repo_id = $3 AND c.kind = 'request_spawn'
          AND c.state IN ('delivered', 'applied') AND c.expires_at > now()
          AND c.args ->> 'role' = $4 AND (c.args ->> 'discussion') = $5::text`,
      [commandId, runnerId, repoId, role, String(discussion)],
    );
    return rows[0] ? { issuedBy: rows[0].issued_by } : null;
  },
  async halted(client, repoId) {
    // EB-11a adds the table. Until it exists nothing can be halted, so its absence is the only case that answers false without a row.
    const present = await client.query<{ present: boolean }>("SELECT to_regclass('engine_repo_controls') IS NOT NULL AS present");
    if (present.rows[0]?.present !== true) return false;
    const { rows } = await client.query<{ halted: boolean }>("SELECT halted_at IS NOT NULL AS halted FROM engine_repo_controls WHERE repo_id = $1", [repoId]);
    return rows[0]?.halted === true;
  },
};

interface ReceiptRow {
  id: string;
  disposition: Disposition;
  subject: Record<string, unknown>;
  answered: "approve" | null;
  choice: "approve" | "decline" | null;
}

const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

const HALTED_REPLY: EngineDecideReply = { disposition: "ask", receipt_id: null, ask_id: null, answered: null, halted: true };

/** What a stored receipt says now: an asked one follows the person's answer; anything else is what it was written as. */
function replyFor(row: ReceiptRow): EngineDecideReply {
  if (row.disposition !== "ask") return { disposition: row.disposition, receipt_id: row.id, ask_id: null, answered: row.answered, halted: false };
  if (row.choice === "approve") return { disposition: "act", receipt_id: row.id, ask_id: row.id, answered: "approve", halted: false };
  return { disposition: "ask", receipt_id: row.id, ask_id: row.id, answered: row.choice, halted: false };
}

const dialSource = (row: { preset: string | null } | null): string =>
  row === null || row.preset === DIAL_DEFAULT_MARKER ? "default" : row.preset !== null && ["cautious", "balanced", "autonomous"].includes(row.preset) ? row.preset : "override";

const SELECT_RECEIPT = `SELECT d.id, d.disposition, d.subject, d.answered, a.choice
       FROM engine_decisions d LEFT JOIN engine_decision_answers a ON a.account_id = d.account_id AND a.decision_id = d.id
      WHERE d.repo_id = $1 AND d.decision_type = $2 AND d.request_key = $3`;

/**
 * POST /api/runner/engine/decide (EB-9a). The engine asks before it spawns an agent, merges a pull request or marks a Spec ready; the
 * answer is the repo's dial for that decision, with a person's answer to an earlier ask on top. It fails closed at every step: a bad
 * signature, body, switch, repo, halt or audit gap answers no, and an unknown tag asks.
 *
 *  - The account and the runner come from the verified key only; the repo must be one this runner covers, enabled for the bridge and
 *    on a `runner_local` machine, and the account's operate switch must be on.
 *  - The same (repo, decision type, request key) is one receipt. Asked again with a different subject it is 409, never a second
 *    answer under the first one's approval.
 *  - A decide that carries the `command_id` of a live `request_spawn` for this repo, role and Discussion is a person's own click: it
 *    acts, in that person's name, once per command. Any other pairing is ignored and the dial decides.
 *  - A repo that is not clearly private (public, or a visibility read that failed) asks for every decision whatever its dial says (D#845 ON-10e2b); a person's own click on a spawn still acts.
 *  - While the repo is halted every decide answers `ask` with `halted: true`, replays included.
 *  - Every answer is audited in the same transaction as the receipt. A failed audit rolls the receipt back and answers 500.
 */
export async function engineDecide(deps: RunnerCloudDeps, req: RunnerHttpRequest, ports: EngineDecidePorts = deps.engineDecide ?? pgEngineDecidePorts): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, ENGINE_DECIDE_PATH, req, { replay: "once" });
  const message = parseEngineDecide(parseJsonBody(req));
  const audit = ports.audit;
  if (audit === undefined) throw new RunnerHttpError(503, "not_configured", "engine decisions are not available yet");
  // D#845 ON-10e2b: the repo's visibility is read live BEFORE the transaction (no network call inside it). A repo the gate would refuse is left to the transaction's own 403.
  const target = await asRunner(() => withRunnerSession(deps.appUserPool, runner, (client) => ports.gate(client, { runnerId: runner.runnerId, repoGhId: message.repo_gh_id })));
  const visibility: ClampVisibility = "repoId" in target ? await readRepoVisibility(deps, runner.accountId, target.repoId) : "unknown";
  let reply: EngineDecideReply;
  try {
    reply = await asRunner(() => withRunnerSession(deps.appUserPool, runner, (client) => decideInside(client, runner, message, ports, (c, e) => audit(c, e, runner.registeredBy), visibility)));
  } catch (error) {
    if (pgCode(error) !== "HX409") throw error;
    // A halt committed between the read and the insert: nothing was written, so the refusal is recorded on its own.
    reply = HALTED_REPLY;
    await asRunner(() =>
      withRunnerSession(deps.appUserPool, runner, async (client) => {
        const gate = await ports.gate(client, { runnerId: runner.runnerId, repoGhId: message.repo_gh_id });
        if ("repoId" in gate) await audit(client, { action: "engine_decision.recorded", repoId: gate.repoId, decisionType: message.decision_type, disposition: "ask" }, runner.registeredBy);
      }),
    );
  }
  return { status: 200, body: EngineDecideReply.parse(reply), headers: { "cache-control": "no-store" } };
}

async function decideInside(client: PoolClient, runner: VerifiedRunner, message: EngineDecideRequest, ports: EngineDecidePorts, audit: (client: PoolClient, entry: EngineDecideAuditEntry) => Promise<void>, visibility: ClampVisibility): Promise<EngineDecideReply> {
  const gate = await ports.gate(client, { runnerId: runner.runnerId, repoGhId: message.repo_gh_id });
  if ("refusal" in gate) throw new RunnerHttpError(403, gate.refusal, "the engine bridge does not accept this decision");
  const repoId = gate.repoId;
  const recorded = async (disposition: Disposition, commandId?: string): Promise<void> =>
    audit(client, { action: "engine_decision.recorded", repoId, decisionType: message.decision_type, disposition, ...(commandId === undefined ? {} : { commandId }) });

  if (await ports.halted(client, repoId)) {
    await recorded("ask");
    return HALTED_REPLY;
  }

  const keyArgs = [repoId, message.decision_type, message.request_key];
  const replay = async (): Promise<EngineDecideReply | null> => {
    const existing = (await client.query<ReceiptRow>(SELECT_RECEIPT, keyArgs)).rows[0];
    if (existing === undefined) return null;
    if (canonical(existing.subject) !== canonical(message.subject)) throw new RunnerHttpError(409, "request_key_reused", "this request key was used for a different decision");
    const reply = replyFor(existing);
    await recorded(reply.disposition);
    return reply;
  };
  const first = await replay();
  if (first !== null) return first;

  const dial = await getCurrentDialSetting(client, repoId, message.decision_type);
  const stored: Disposition | null = dial === null || dial.preset === DIAL_DEFAULT_MARKER ? null : (dial.disposition as Disposition);
  const resolved = resolveEngineDecision({ decisionType: message.decision_type, tag: message.subject.tag, stored });
  // A repo that is not clearly private asks for every decision, whatever the stored dial or preset says (Ruling 89 section 2.4). A person's own click on a spawn (below) is still an answer.
  const clamped = clampForVisibility(resolved.disposition, visibility);
  let disposition: Disposition = clamped;
  let answeredBy: string | null = null;
  let commandId: string | null = null;

  const { role, discussion } = message.subject;
  if (message.decision_type === "engine_spawn" && message.command_id !== undefined && role !== undefined && discussion !== undefined) {
    const spent = await client.query("SELECT 1 FROM engine_decisions WHERE repo_id = $1 AND command_id = $2 AND answered IS NOT NULL", [repoId, message.command_id]);
    const cover = spent.rowCount === 0 ? await ports.coveringCommand(client, { runnerId: runner.runnerId, repoId, commandId: message.command_id, role, discussion }) : null;
    if (cover !== null) {
      disposition = "act";
      answeredBy = cover.issuedBy;
      commandId = message.command_id;
    }
  }

  const insert = (by: string | null, command: string | null, answer: "approve" | null, chosen: Disposition) =>
    client.query<{ id: string }>(
      `INSERT INTO engine_decisions (account_id, repo_id, decision_type, request_key, subject, disposition, catalogue_version, preset, resolved_via, answered_by, answered, command_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT DO NOTHING RETURNING id`,
      [runner.accountId, repoId, message.decision_type, message.request_key, JSON.stringify(message.subject), chosen, CATALOGUE_VERSION, dialSource(dial), resolved.resolvedVia, by, answer, command],
    );
  let inserted = await insert(answeredBy, commandId, answeredBy === null ? null : "approve", disposition);
  if (inserted.rowCount === 0) {
    // Lost a race: the same key was written by a concurrent decide (answer with its receipt), or the command was spent by another key (the dial decides).
    const raced = await replay();
    if (raced !== null) return raced;
    answeredBy = null;
    commandId = null;
    disposition = clamped;
    inserted = await insert(null, null, null, disposition);
    if (inserted.rowCount === 0) return (await replay()) ?? HALTED_REPLY;
  }
  const id = inserted.rows[0]!.id;
  await recorded(disposition, commandId ?? undefined);
  return { disposition, receipt_id: id, ask_id: disposition === "ask" ? id : null, answered: answeredBy === null ? null : "approve", halted: false };
}
