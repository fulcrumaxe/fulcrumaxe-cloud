import type { PoolClient } from 'pg';

/**
 * The audit actions the engine bridge writes (migration 1026). Each is one row per person's act or engine-side outcome, written through `audit_write`
 * in the same transaction as the change it records, so a failed audit write rolls the change back.
 */
export const ENGINE_AUDIT_ACTIONS = [
  'engine_bridge.settings_changed',
  'engine_bridge.data_deleted',
  'engine_command.issued',
  'engine_command.acked',
  'engine_command.cancelled',
  'engine_decision.recorded',
  'engine_decision.answered',
  'engine_halt.set',
  'engine_halt.cleared',
  // D#845 ON-10e2a (migration 1098): the person's consent to survey a public repo, written in the run's create transaction.
  'project.public_survey_consented',
] as const;

export type EngineAuditAction = (typeof ENGINE_AUDIT_ACTIONS)[number];

/** The only keys an engine audit payload may carry: ids and enums, never text a person or the engine wrote. */
export const ENGINE_AUDIT_PAYLOAD_KEYS = ['repo_id', 'command_id', 'kind', 'outcome', 'refusal', 'decision_type', 'disposition', 'halt_epoch', 'setup_id', 'run_id', 'head_sha', 'runner_id'] as const;

export type EngineAuditPayload = Partial<Record<(typeof ENGINE_AUDIT_PAYLOAD_KEYS)[number], string | number | boolean | null>>;

const ACTIONS: ReadonlySet<string> = new Set(ENGINE_AUDIT_ACTIONS);
const KEYS: ReadonlySet<string> = new Set(ENGINE_AUDIT_PAYLOAD_KEYS);

/** Thrown before any query when the action or payload is outside what the bridge may record. The message names a key, never a value. */
export class EngineAuditRefused extends Error {
  constructor(message: string) {
    super(`engineAudit: ${message}`);
    this.name = 'EngineAuditRefused';
  }
}

/**
 * Writes one engine audit row on the caller's tenant transaction (the client must come from `withTenant`). Fails closed: an unknown action, a key
 * outside {@link ENGINE_AUDIT_PAYLOAD_KEYS}, or a value that is not a string, finite number, boolean or null is refused before the database is touched.
 * Returns the audit row id.
 */
export async function writeEngineAudit(client: Pick<PoolClient, 'query'>, action: EngineAuditAction, payload: EngineAuditPayload): Promise<string> {
  if (!ACTIONS.has(action)) throw new EngineAuditRefused('unknown action');
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new EngineAuditRefused('payload must be an object');
  const proto = Object.getPrototypeOf(payload);
  if (proto !== Object.prototype && proto !== null) throw new EngineAuditRefused('payload must be a plain object');
  for (const key of Object.keys(payload)) {
    if (!KEYS.has(key)) throw new EngineAuditRefused(`payload key "${key.slice(0, 40)}" is not allowed`);
    const v = (payload as Record<string, unknown>)[key];
    const ok = v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
    if (!ok) throw new EngineAuditRefused(`payload key "${key}" must be a string, number, boolean or null`);
  }
  const { rows } = await client.query<{ id: string }>('SELECT audit_write($1::text, $2::jsonb) AS id', [action, JSON.stringify(payload)]);
  return rows[0]!.id;
}
