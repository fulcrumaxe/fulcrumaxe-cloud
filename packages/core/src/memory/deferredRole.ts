import type { PoolClient } from 'pg';
import { ingestInClient, lockMemoryIntake, type MemoryProposalsEvent } from './intake.js';
import { getPendingHooks } from '../pendingWork.js';
import type { LiveSecretsSource } from './index.js';

/**
 * D#601 MEM-9: role lessons wait for their work item. A run ends before its item merges, so the first intake (at the end of the run) refuses a role
 * proposal `item_not_terminal` after checking its text, and records that in the run's `memory.proposals` event. When the item reaches a terminal stage,
 * `recordStage` calls this in the same transaction as the move: every run of the item whose event lists such a refusal gets those proposals taken in
 * once more (a `memory.role_proposals` event makes it once per run). No agent run, no cron and no poll are involved. A proposal whose item never gets
 * there is simply never taken in; nothing was stored for it, so there is nothing to expire.
 *
 * The pass runs as the pipeline does, with no user in the session (a person closing an item would otherwise write as that person), and puts the user
 * back afterwards. A failure never fails the stage move: see the catch below.
 */
export const MEMORY_ROLE_PROPOSALS_EVENT_KIND = 'memory.role_proposals';
/** The fixed code of the event a failed pass leaves on the run (also on the telemetry allowlist). */
export const ROLE_INTAKE_FAILED_CODE = 'role_intake_failed';
export const MEMORY_ROLE_FAILED_EVENT_KIND = 'memory.role_proposals_failed';

let liveSecrets: LiveSecretsSource = () => [];
/** The process that holds installation tokens (the worker) registers them here so this pass scans against them too. Others scan the shapes only; the first pass already scanned the live values. */
export function setDeferredRoleLiveSecrets(source: LiveSecretsSource): void {
  liveSecrets = source;
}

type Sink = (err: unknown, stage: string) => void;
let errorSink: Sink | null = null;
/** The process's error sink (the worker passes telemetry's `reportError`). Without one, the pending-work hooks' reporter is used, then nothing. */
export function setDeferredRoleErrorSink(sink: Sink | null): void {
  errorSink = sink;
}
function report(err: unknown): void {
  try {
    (errorSink ?? getPendingHooks()?.reportError)?.(err, 'memory.role_deferred');
  } catch {
    // fx-swallow-ok: the sink itself must never break a stage move
  }
}

interface RunRow {
  id: string;
  role: string;
  envelope: unknown;
  payload: { refused?: Array<{ index: number; reason: string }> } | null;
}

/**
 * `run_events` has exactly two writers (a guard test pins it), and the runner's is one of them, so this module writes through it instead of inserting
 * itself. The runner registers its writer when it loads (every process that records stage moves loads it); a global, because Next bundles each route apart.
 */
export type RunEventWriter = (client: PoolClient, accountId: string, runId: string, kind: string, payload: Record<string, unknown>) => Promise<void>;
const WRITER_KEY = Symbol.for('fx.memory.deferredRole.runEventWriter');
export function setDeferredRoleEventWriter(writer: RunEventWriter | null): void {
  (globalThis as { [WRITER_KEY]?: RunEventWriter | null })[WRITER_KEY] = writer;
}
async function writeEvent(c: PoolClient, accountId: string, runId: string, kind: string, payload: Record<string, unknown>): Promise<void> {
  const writer = (globalThis as { [WRITER_KEY]?: RunEventWriter | null })[WRITER_KEY];
  if (!writer) throw new Error('no run-event writer is registered for the deferred role pass');
  await writer(c, accountId, runId, kind, payload);
}

export async function ingestDeferredRoleProposals(client: PoolClient, workItemId: string): Promise<void> {
  await client.query('SAVEPOINT memory_role_deferred');
  const before = (await client.query<{ u: string | null }>(`SELECT current_setting('app.user_id', true) AS u`)).rows[0]!.u;
  let accountId: string | undefined;
  let current: string | null = null;
  try {
    const { rows: acct } = await client.query<{ account_id: string }>('SELECT account_id FROM work_items WHERE id = $1', [workItemId]);
    accountId = acct[0]?.account_id;
    if (accountId === undefined) return;
    // The same per-account lock the first intake takes, BEFORE looking for runs: a first intake that read this item as unfinished either commits its
    // refusal before this pass looks (and is found), or waits for this move to commit and then reads the item as finished.
    await lockMemoryIntake(client, accountId);
    const { rows } = await client.query<RunRow>(
      `SELECT ar.id, ar.role, ar.envelope, ev.payload
         FROM agent_runs ar
         JOIN run_events ev ON ev.account_id = ar.account_id AND ev.run_id = ar.id AND ev.kind = 'memory.proposals'
        WHERE ar.account_id = $1 AND ar.work_item_id = $2 AND ar.runtime <> 'runner' AND jsonb_typeof(ar.envelope -> 'memory_proposals') = 'array'
          AND NOT EXISTS (SELECT 1 FROM run_events d WHERE d.account_id = ar.account_id AND d.run_id = ar.id AND d.kind = '${MEMORY_ROLE_PROPOSALS_EVENT_KIND}')`,
      [accountId, workItemId],
    );
    await client.query(`SELECT set_config('app.user_id', '', true)`);
    for (const run of rows) {
      current = run.id;
      const all = (run.envelope as { memory_proposals: unknown[] }).memory_proposals;
      const list = (run.payload?.refused ?? []).filter((r) => r.reason === 'item_not_terminal' && Number.isInteger(r.index) && r.index < all.length).map((r) => all[r.index]);
      if (list.length === 0) continue;
      await ingestInClient(
        client,
        {
          accountId,
          runId: run.id,
          workItemId,
          role: run.role,
          source: 'agent',
          envelope: null,
          liveSecrets,
          allowRoleScope: true,
          itemTerminal: true,
          eventKind: MEMORY_ROLE_PROPOSALS_EVENT_KIND,
          recordEvent: async (c, event: MemoryProposalsEvent) => {
            await writeEvent(c, accountId!, run.id, MEMORY_ROLE_PROPOSALS_EVENT_KIND, { ...event });
          },
        },
        list,
        await liveSecrets(),
      );
    }
    await client.query('RELEASE SAVEPOINT memory_role_deferred');
  } catch (err) { // fx-swallow-ok: reported below through the sink; the stage move must not fail
    // The stage move must never fail, so nothing is thrown. Everything this pass wrote is rolled back, which leaves the proposals un-taken-in: the run's
    // first event still lists them, so the item's next terminal move tries again. The failure leaves a fixed-code event and goes to the error sink.
    await client.query('ROLLBACK TO SAVEPOINT memory_role_deferred').catch(() => undefined);
    if (accountId !== undefined && current !== null) {
      await writeEvent(client, accountId, current, MEMORY_ROLE_FAILED_EVENT_KIND, { code: ROLE_INTAKE_FAILED_CODE }).catch(report);
    }
    await client.query('RELEASE SAVEPOINT memory_role_deferred').catch(() => undefined);
    report(err);
  } finally {
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [before ?? '']).catch(() => undefined);
  }
}
