import { SANDBOX_COMMAND_CAPABILITY, SANDBOX_INVENTORY_MIN_PROTOCOL } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import type { RunnerCloudDeps } from "./http.js";

/**
 * D#587 B-7b-ii: what the fleet page shows about each runner's sandboxes. DISPLAY ONLY. The inventory, its last-seen time and the host limits are claims by a
 * semi-trusted machine; nothing here gates a request (the enqueue route re-checks the runner, its protocol and its capability itself, and the database checks
 * the role). The one flag this file computes for the page, `can_command`, reads the runner's registration and its listed capability, never the inventory.
 *
 * Every query carries its own account predicate on top of row security. The commands are the account's own record of who asked for what, newest first.
 */

/** How the inventory reads: never reported, current, left behind by a runner that fell below protocol 21 or went back to `os_sandbox`, or its runner is removed. */
export type InventoryStatus = "never" | "current" | "stale_older" | "stale_engine" | "removed";

/** The state a screen shows for a command: `pending` past its life is `expired`, and `delivered` past its life with no answer is `unanswered`. */
export type ShownCommandState = "pending" | "delivered" | "applied" | "refused" | "expired" | "unanswered" | "cancelled";

export const SANDBOX_COMMANDS_SHOWN = 10;

export interface RunnerSandboxView {
  status: InventoryStatus;
  /** When the runner last reported its list (ISO), or null when it never has. Shown so a stale list says how old it is. */
  seen_at: string | null;
  limits: { vms: number | null; vcpus: number | null; memory_mb: number | null; templates: string[] };
  sandboxes: Array<{ name: string; state: string; created_at: string; last_used_at: string | null; disk_bytes: number; snapshot_count: number; snapshot_newest_secs: number | null }>;
  /** True when the buttons may be offered: the runner is not removed, it listed the capability at protocol 21 or later, and its list is current. */
  can_command: boolean;
  commands: Array<{ id: string; kind: string; name: string | null; state: ShownCommandState; refusal: string | null; issued_at: string; expires_at: string }>;
}

interface RunnerRead {
  runner_id: string;
  protocol_version: number;
  revoked: boolean;
  engine: string | null;
  max_vms: number | null;
  max_vcpus: number | null;
  max_memory_mb: number | null;
  templates: string[] | null;
  seen_at: Date | null;
  takes_commands: boolean;
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** The sandbox view of every runner of the account, by runner id. Read in the caller's tenant context. */
export async function readSandboxViews(deps: Pick<RunnerCloudDeps, "appUserPool">, accountId: string, userId: string): Promise<Map<string, RunnerSandboxView>> {
  return withTenant(deps.appUserPool, accountId, userId, async (client) => {
    const runners = (
      await client.query<RunnerRead>(
        `SELECT rn.id AS runner_id, rn.protocol_version, rn.revoked_at IS NOT NULL AS revoked, f.sandbox_engine AS engine,
                f.max_vms, f.max_vcpus, f.max_memory_mb, f.bootable_templates AS templates, rep.seen_at,
                COALESCE($2::text = ANY (cap.capabilities), false) AS takes_commands
           FROM runners rn
                LEFT JOIN runner_facts f ON f.account_id = rn.account_id AND f.runner_id = rn.id
                LEFT JOIN runner_sandbox_reports rep ON rep.account_id = rn.account_id AND rep.runner_id = rn.id
                LEFT JOIN runner_capabilities cap ON cap.account_id = rn.account_id AND cap.runner_id = rn.id
          WHERE rn.account_id = $1`,
        [accountId, SANDBOX_COMMAND_CAPABILITY],
      )
    ).rows;
    const boxes = (
      await client.query<{ runner_id: string; name: string; state: string; created_at: Date; last_used_at: Date | null; disk_bytes: string; snapshot_count: number; snapshot_age_s: string | null }>(
        `SELECT runner_id, name, state, created_at, last_used_at, disk_bytes, snapshot_count, snapshot_age_s
           FROM runner_sandboxes WHERE account_id = $1 ORDER BY runner_id, slot`,
        [accountId],
      )
    ).rows;
    const commands = (
      await client.query<{ id: string; runner_id: string; kind: string; name: string | null; shown: ShownCommandState; refusal: string | null; issued_at: Date; expires_at: Date }>(
        `SELECT id, runner_id, kind, name, refusal, issued_at, expires_at,
                CASE WHEN state = 'pending' AND expires_at <= now() THEN 'expired'
                     WHEN state = 'delivered' AND expires_at <= now() THEN 'unanswered' ELSE state END AS shown
           FROM (SELECT c.*, row_number() OVER (PARTITION BY c.runner_id ORDER BY c.issued_at DESC, c.id DESC) AS n
                   FROM sandbox_commands c WHERE c.account_id = $1 AND c.issued_at > now() - interval '1 day') recent
          WHERE n <= $2 ORDER BY runner_id, issued_at DESC, id DESC`,
        [accountId, SANDBOX_COMMANDS_SHOWN],
      )
    ).rows;
    const views = new Map<string, RunnerSandboxView>();
    for (const r of runners) {
      const status: InventoryStatus = r.revoked ? "removed" : r.seen_at === null ? "never" : r.protocol_version < SANDBOX_INVENTORY_MIN_PROTOCOL ? "stale_older" : r.engine !== "microvm" ? "stale_engine" : "current";
      views.set(r.runner_id, {
        status,
        seen_at: iso(r.seen_at),
        limits: { vms: r.max_vms, vcpus: r.max_vcpus, memory_mb: r.max_memory_mb, templates: r.templates ?? [] },
        sandboxes: boxes
          .filter((b) => b.runner_id === r.runner_id)
          .map((b) => ({ name: b.name, state: b.state, created_at: b.created_at.toISOString(), last_used_at: iso(b.last_used_at), disk_bytes: Number(b.disk_bytes), snapshot_count: b.snapshot_count, snapshot_newest_secs: b.snapshot_age_s === null ? null : Number(b.snapshot_age_s) })),
        // `current` already means: not removed, protocol 21 or later, and the microvm engine.
        can_command: r.takes_commands && status === "current",
        commands: commands
          .filter((c) => c.runner_id === r.runner_id)
          .map((c) => ({ id: c.id, kind: c.kind, name: c.name, state: c.shown, refusal: c.refusal, issued_at: c.issued_at.toISOString(), expires_at: c.expires_at.toISOString() })),
      });
    }
    return views;
  });
}
