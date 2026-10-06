import type { Pool, PoolClient } from 'pg';
import { withPlatformOps } from '@fx/core/src/tenancy/withPlatformOps.js';
import { assertPlanPathKind, isPlanPathKind, PLAN_PATH_KINDS, type PlanPathKind } from './planKinds.js';

/**
 * D#221 KS part 1: the server-side switch per plan-based kind. Writes are platform_ops-only by grant (and each flip
 * is audited by a trigger in the same transaction); reads are open to the app role because admit runs under a tenant
 * context and the state is not secret.
 *
 * Fail closed: a missing row, an unknown kind or a non-boolean value reads as OFF. A kind is usable only while its
 * switch is explicitly on. Part 2 reads this at admit and at the firewall; the reason string below is the one named
 * reason both places show.
 */
export const KILL_SWITCH_REFUSAL_REASON = 'plan_kind_disabled';

export interface KindSwitchState {
  kind: PlanPathKind;
  enabled: boolean;
  updated_by: string;
  updated_at: Date;
}

/** Reads one switch inside the caller's own transaction/client (admit's, the firewall's). Unknown kind: false. */
export async function isKindEnabledWithClient(client: PoolClient, kind: string): Promise<boolean> {
  if (!isPlanPathKind(kind)) return false;
  const { rows } = await client.query<{ enabled: boolean }>(
    'SELECT enabled FROM plan_kind_switches WHERE kind = $1',
    [kind],
  );
  return rows[0]?.enabled === true;
}

/** Reads one switch on a pool of any role that may SELECT it. Always a fresh read: nothing is cached. */
export function isKindEnabled(pool: Pool, kind: string): Promise<boolean> {
  return withPlatformOps(pool, (client) => isKindEnabledWithClient(client, kind));
}

/** Both switches, always one entry per plan-based kind (a missing row reads as off). */
export async function listKindSwitches(pool: Pool): Promise<KindSwitchState[]> {
  return withPlatformOps(pool, async (client) => {
    const { rows } = await client.query<KindSwitchState>(
      'SELECT kind, enabled, updated_by, updated_at FROM plan_kind_switches',
    );
    return PLAN_PATH_KINDS.map(
      (kind) =>
        rows.find((r) => r.kind === kind) ?? { kind, enabled: false, updated_by: 'unset', updated_at: new Date(0) },
    );
  });
}

export interface SetKindEnabledResult {
  kind: PlanPathKind;
  enabled: boolean;
  /** False when the switch was already in the requested state (nothing audited). */
  changed: boolean;
}

/**
 * Turns one kind on or off. `platformOpsPool` MUST be the platform_ops login: the grant is the enforcement, an
 * app_user pool gets permission denied. `actor` names who flipped it (1-200 chars) and lands in the audit row.
 */
export async function setKindEnabled(
  platformOpsPool: Pool,
  kind: string,
  enabled: boolean,
  actor: string,
): Promise<SetKindEnabledResult> {
  assertPlanPathKind(kind);
  if (typeof enabled !== 'boolean') throw new TypeError('kill switch: enabled must be a boolean');
  if (typeof actor !== 'string' || actor.trim().length === 0 || actor.length > 200) {
    throw new TypeError('kill switch: actor must be 1-200 characters');
  }
  return withPlatformOps(platformOpsPool, async (client) => {
    const { rows: before } = await client.query<{ enabled: boolean }>(
      'SELECT enabled FROM plan_kind_switches WHERE kind = $1 FOR UPDATE',
      [kind],
    );
    if (before.length === 0) throw new Error('kill switch: no switch row for this kind');
    const changed = before[0]!.enabled !== enabled;
    await client.query(
      'UPDATE plan_kind_switches SET enabled = $2, updated_by = $3, updated_at = now() WHERE kind = $1',
      [kind, enabled, actor],
    );
    return { kind, enabled, changed };
  });
}
