/**
 * The runner's `InventorySource` and `SandboxLifecycle` on top of the adapter (D#587 B-5b), so the claim's inventory block and the signed stop,
 * delete and reap commands read and change the same table the port uses. Both go through `DaemonSdk`, never the daemon directly, so the adapter's
 * timers, policy listeners and name table cannot fall out of step with the VMs.
 *
 * The shapes are written here structurally (this file's package may not import the protocol's inventory types in this stack); they are the
 * protocol's `SandboxInventoryRow` and the receive path's `SandboxLifecycle`, and the wiring in the runner's `run` is where `tsc` holds them together.
 * Names are the daemon's ids (`sb-` and 32 hex digits): the cloud never sees a port name, which can be a run's branch-derived text.
 *
 * Not measured yet, so reported as the schema's least claim and never as a figure: disk bytes (0), snapshot count (0) and age (null) until snapshots exist (B-3).
 */
import type { DaemonSdk, ManagedSandbox } from "./sdkAdapter.js";
import { SandboxdSdkError } from "./sdkAdapter.js";

export const MAX_INVENTORY_ROWS = 200;
export interface InventoryRowShape {
  name: string;
  state: "creating" | "running" | "stopped" | "snapshotted" | "error";
  created_at: string;
  last_used_at: string | null;
  disk_bytes: number;
  snapshot_count: number;
  snapshot_age_s: number | null;
}
export interface InventorySourceShape { list(): Promise<readonly InventoryRowShape[]> }
export type LifecycleResultShape = { ok: true } | { ok: false; refusal: "name_unknown" | "in_use" | "unsupported" | "failed" };
export interface SandboxLifecycleShape {
  stop(name: string): Promise<LifecycleResultShape>;
  delete(name: string): Promise<LifecycleResultShape>;
  reapStopped(): Promise<LifecycleResultShape>;
}

const STATE: Record<ManagedSandbox["state"], InventoryRowShape["state"]> = { pending: "creating", running: "running", stopping: "running", stopped: "stopped" };
const iso = (ms: number): string => new Date(ms).toISOString();

export function daemonInventorySource(sdk: Pick<DaemonSdk, "managed">): InventorySourceShape {
  return {
    async list() {
      return [...sdk.managed()]
        .sort((a, b) => b.createdAtMs - a.createdAtMs)
        .slice(0, MAX_INVENTORY_ROWS) // past the schema's cap the whole block would be refused, so the newest are kept
        .map((m) => ({ name: m.id, state: STATE[m.state], created_at: iso(m.createdAtMs), last_used_at: iso(m.lastUsedAtMs), disk_bytes: 0, snapshot_count: 0, snapshot_age_s: null }));
    },
  };
}

async function result(work: () => Promise<unknown>): Promise<LifecycleResultShape> {
  try {
    await work();
    return { ok: true };
  } catch (err) {
    // fx-swallow-ok: the outcome is the answer; only a busy sandbox is told apart, every other failure is the one fixed word
    return { ok: false, refusal: err instanceof SandboxdSdkError && err.response.status === 409 ? "in_use" : "failed" };
  }
}

export function daemonSandboxLifecycle(sdk: Pick<DaemonSdk, "stopById" | "deleteById" | "reapStopped">): SandboxLifecycleShape {
  return {
    stop: (name) => result(() => sdk.stopById(name)),
    delete: (name) => result(() => sdk.deleteById(name)),
    reapStopped: () => result(() => sdk.reapStopped()),
  };
}
