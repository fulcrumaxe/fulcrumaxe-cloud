/**
 * The slice of the cloud runner's `VercelSandboxSdk` that `sdkAdapter.ts` implements, copied here because this package's source may import
 * nothing from the cloud runner package (it is a dev dependency only). The copy is held to the original by `sdkAdapter.test.ts`, which assigns the
 * adapter to the real `VercelSandboxSdk`: if either side drifts, `tsc` fails there. A network policy is opaque here (`unknown`; the
 * policy port that receives it is the only reader).
 */
export interface SdkCommand {
  readonly cmdId?: string;
  logs(opts?: { signal?: AbortSignal }): AsyncIterable<{ stream: string; data: unknown }>;
  wait(params?: { signal?: AbortSignal }): Promise<{ exitCode: number }>;
  kill(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
}

export interface SdkSession {
  id: string;
  memory?: number;
  region?: string;
  duration?: number;
  activeCpuDurationMs?: number;
  networkTransfer?: { ingress: number; egress: number };
}
export interface SdkSessionPage { sessions: SdkSession[]; pagination: { next: string | null } }

export interface SdkSandbox {
  readonly name: string;
  runCommand(params: { cmd: string; args?: string[]; cwd?: string; env?: Record<string, string>; detached: true; signal?: AbortSignal }): Promise<SdkCommand>;
  writeFiles(files: { path: string; content: string; mode?: number }[], opts?: { signal?: AbortSignal }): Promise<void>;
  updateNetworkPolicy(policy: unknown, opts?: { signal?: AbortSignal }): Promise<unknown>;
  extendTimeout(durationMs: number, opts?: { signal?: AbortSignal }): Promise<void>;
  stop(opts?: { signal?: AbortSignal }): Promise<unknown>;
  delete(opts?: { deleteOrphanSnapshots?: boolean; signal?: AbortSignal }): Promise<void>;
  readonly status: string;
  readonly persistent?: boolean;
  readonly image?: string;
  readonly vcpus?: number;
  readonly keepLastSnapshots?: { count?: number };
  readonly timeout?: number;
  currentSession(): { readonly sessionId: string; getCommand?(cmdId: string, opts?: { signal?: AbortSignal }): Promise<SdkCommand> };
  listSessions(params?: { limit?: number; cursor?: string; sortOrder?: "asc" | "desc"; signal?: AbortSignal }): Promise<SdkSessionPage>;
}

export interface SdkListedSandbox {
  name: string;
  persistent: boolean;
  createdAt: number;
  updatedAt: number;
  status: "pending" | "running" | "stopping" | "stopped" | "failed" | "aborted" | "snapshotting";
}
export interface SdkSandboxListPage { sandboxes: SdkListedSandbox[]; pagination: { next: string | null } }

export interface VercelCredentials { teamId: string; projectId: string; token: string }
export interface SdkCreateParams extends VercelCredentials {
  name: string;
  image: string;
  timeout: number;
  persistent: boolean;
  resources: { vcpus: number };
  tags: Record<string, string>;
  keepLastSnapshots?: { count: number };
  networkPolicy: unknown;
  signal?: AbortSignal;
}

export interface VercelSandboxSdk {
  create(params: SdkCreateParams): Promise<SdkSandbox>;
  get(params: { name: string; resume?: boolean; signal?: AbortSignal; fetch?: typeof fetch } & VercelCredentials): Promise<SdkSandbox>;
  list?(params: { namePrefix: string; cursor?: string; signal?: AbortSignal; fetch?: typeof fetch } & VercelCredentials): Promise<SdkSandboxListPage>;
}
