import type { Sandbox } from "@vercel/sandbox";
import type { SdkListedSandbox, SdkSandbox, VercelCredentials, VercelSandboxSdk } from "../../src/vercelSandboxPort.js";

/**
 * The `@vercel/sandbox` 3.5.1 surface the SANDBOX-REAPER reads and deletes through, behind the `VercelSandboxSdk` seam, typed
 * against the SDK's own list item. It models what the service does that the reaper touches: pagination through `pagination.next`
 * with a page limit, server-side `namePrefix` filtering, every status, a 404 for a gone sandbox (so a second delete answers 404),
 * snapshots that survive a delete unless `deleteOrphanSnapshots` is true, 429/5xx on request, and a `get` without `resume` that
 * never starts a session (anything that would wake or run a sandbox is recorded in `waking`, which a read-only pass leaves empty).
 */
type SdkListItem = Awaited<ReturnType<typeof Sandbox.list>>["sandboxes"][number];
type SdkStatus = SdkListItem["status"];

export function httpError(status: number): Error {
  return Object.assign(new Error(`http ${status}`), { response: { status } });
}

export interface ReaperSdkFake {
  sdk: VercelSandboxSdk;
  calls: string[];
  waking: string[];
  estate: Map<string, { status: SdkStatus; persistent: boolean }>;
  /** Names whose snapshot the service still holds. */
  snapshots: Set<string>;
  seed(name: string, status?: SdkStatus, opts?: { persistent?: boolean; snapshot?: boolean }): void;
  /** Answer the next calls of `op` with this status (429, 500, ...), `times` times. */
  failNext(op: "list" | "get" | "delete", status: number, times?: number): void;
  pageLimit: number;
  /** The `listed` argument of each `list` call. */
  listQueries: Array<{ namePrefix: string; cursor?: string; creds: VercelCredentials }>;
}

export function createReaperSdkFake(): ReaperSdkFake {
  const calls: string[] = [];
  const waking: string[] = [];
  const estate = new Map<string, { status: SdkStatus; persistent: boolean }>();
  const snapshots = new Set<string>();
  const failures: Array<{ op: string; status: number; times: number }> = [];
  const listQueries: ReaperSdkFake["listQueries"] = [];
  let clock = 1_700_000_000_000;
  const created = new Map<string, number>();
  const fake: ReaperSdkFake = {
    sdk: undefined as unknown as VercelSandboxSdk,
    calls,
    waking,
    estate,
    snapshots,
    listQueries,
    pageLimit: 2,
    seed(name, status = "stopped", opts = {}) {
      estate.set(name, { status, persistent: opts.persistent ?? name.startsWith("ex-") });
      created.set(name, ++clock);
      if (opts.snapshot ?? name.startsWith("ex-")) snapshots.add(name);
    },
    failNext(op, status, times = 1) {
      failures.push({ op, status, times });
    },
  };
  const maybeFail = (op: string): void => {
    const f = failures.find((x) => x.op === op && x.times > 0);
    if (f) {
      f.times--;
      throw httpError(f.status);
    }
  };

  const sandboxOf = (name: string): SdkSandbox => ({
    name,
    get status() {
      return estate.get(name)!.status;
    },
    async delete(opts) {
      calls.push(`delete:${name}`);
      maybeFail("delete");
      if (!estate.has(name)) throw httpError(404);
      estate.delete(name);
      // The service keeps a deleted sandbox's snapshots until they expire, unless asked (the SDK's own option).
      if (opts?.deleteOrphanSnapshots === true) snapshots.delete(name);
    },
    async stop() {
      calls.push(`stop:${name}`);
      const s = estate.get(name);
      if (s) s.status = "stopped";
    },
    async runCommand() {
      waking.push(`runCommand:${name}`);
      throw new Error("a read-only pass must not run a command");
    },
    writeFiles: async () => void waking.push(`writeFiles:${name}`),
    updateNetworkPolicy: async () => void waking.push(`updateNetworkPolicy:${name}`),
    extendTimeout: async () => void waking.push(`extendTimeout:${name}`),
    currentSession() {
      if (estate.get(name)?.status !== "running") waking.push(`currentSession:${name}`);
      return { sessionId: `sess-${name}` };
    },
    async listSessions() {
      waking.push(`listSessions:${name}`);
      return { sessions: [], pagination: { next: null } };
    },
  });

  fake.sdk = {
    async create() {
      throw new Error("the reaper never creates a sandbox");
    },
    async get(params) {
      calls.push(`get:${params.name}:resume=${String(params.resume)}`);
      maybeFail("get");
      if (params.resume === true) waking.push(`get-resume:${params.name}`);
      if (!estate.has(params.name)) throw httpError(404);
      return sandboxOf(params.name);
    },
    async list(params) {
      calls.push(`list:${params.namePrefix}:${params.cursor ?? ""}`);
      maybeFail("list");
      const { teamId, projectId, token } = params;
      listQueries.push({ namePrefix: params.namePrefix, ...(params.cursor !== undefined && { cursor: params.cursor }), creds: { teamId, projectId, token } });
      const matching = [...estate.entries()].filter(([name]) => name.startsWith(params.namePrefix));
      const from = params.cursor === undefined ? 0 : Number(params.cursor);
      const page = matching.slice(from, from + fake.pageLimit).map(([name, s]) => {
        const item = {
          name,
          persistent: s.persistent,
          status: s.status,
          createdAt: created.get(name)!,
          updatedAt: created.get(name)!,
          currentSessionId: `sess-${name}`,
        } satisfies Pick<SdkListItem, "name" | "persistent" | "status" | "createdAt" | "updatedAt" | "currentSessionId">;
        return item satisfies SdkListedSandbox & { currentSessionId: string };
      });
      return { sandboxes: page, pagination: { next: from + fake.pageLimit < matching.length ? String(from + fake.pageLimit) : null } };
    },
  };
  return fake;
}
