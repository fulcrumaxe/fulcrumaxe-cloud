import { sandboxRates } from './pricing.js';

/**
 * D#2 COMPUTE-SETTLE CS-1: what Vercel bills for sandbox sessions, from the figures it
 * reports (rates in `pricing.ts`, iad1 only). Memory is billed per started minute; only
 * egress is billed (the port opens no ports); bytes -> GB uses 1e9, 7% high on purpose.
 */

/** Regions with a rate row. Every rate in `pricing.ts` is the iad1 rate. */
const PRICED_REGIONS: ReadonlySet<string> = new Set(['iad1']);

/** Every sandbox is created with these vCPUs (Vercel gives 2048 MB per vCPU). */
export const SANDBOX_PINNED_VCPUS = 2;

/** The figures known for one session; any can be missing (CPU and network are reported only once the VM is stopped). */
export interface SandboxSessionFigures {
  /** Which session these are (not used for pricing). */
  sessionId?: string;
  activeCpuMs?: number;
  durationMs?: number;
  memoryMb?: number;
  egressBytes?: number;
  region?: string;
  /** The runner's own in-VM counters (tier 2 only). */
  selfMeasured?: SandboxSelfMeasured;
  /** The runner's own start-to-stop wall time (used only when the provider reports no duration). */
  ownDurationMs?: number;
}

/** What the runner read inside the VM just before stopping it. */
export interface SandboxSelfMeasured {
  cpuMs: number;
  txBytes: number;
  /** The VM's uptime; a counter that reset shows as an uptime far below the wall time. */
  uptimeMs?: number;
}

/** The in-VM counters are written by code the agent controls, so they are bounded by what the VM could physically have used. */
/** CPU time cannot exceed wall time x vCPUs; 2% allows for clock skew between our wall time and the VM's. */
const SELF_MEASURED_CPU_TOLERANCE = 1.02;
/** Bytes cannot exceed wall seconds x this: 125 MB/s is a 1 Gbps link, far above what a 2-vCPU sandbox sends. */
const MAX_EGRESS_BYTES_PER_SECOND = 125_000_000;

/** A counter whose uptime is below the session's wall time by more than max(30 s, 10% of wall) came from a VM that restarted. */
const SELF_MEASURED_RESET_MIN_SLACK_MS = 30_000;
const SELF_MEASURED_RESET_SLACK_FRACTION = 0.1;

function isFigure(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

const round4 = (usd: number): number => Math.round(usd * 10_000) / 10_000;
const cpuTerm = (cpuMs: number): number => (cpuMs / 3_600_000) * sandboxRates().cpuUsdPerHour;
const egressTerm = (bytes: number): number => (bytes / 1e9) * sandboxRates().dataTransferUsdPerGb;
const memoryTerm = (memoryMb: number, wallMs: number): number =>
  (memoryMb / 1024) * (Math.ceil(wallMs / 60_000) / 60) * sandboxRates().memUsdPerGbHour;

/** The session's USD cost (4 dp), or `undefined` for a region with no rate row or a missing figure. */
export function sandboxSessionUsd(s: SandboxSessionFigures): number | undefined {
  if (s.region === undefined || !PRICED_REGIONS.has(s.region)) return undefined;
  const { activeCpuMs, durationMs, memoryMb, egressBytes } = s;
  if (!isFigure(activeCpuMs) || !isFigure(durationMs) || !isFigure(memoryMb) || !isFigure(egressBytes)) return undefined;
  return round4(cpuTerm(activeCpuMs) + memoryTerm(memoryMb, durationMs) + egressTerm(egressBytes));
}

/** A run's measured cost: the sum over its sessions, `undefined` if it has none or ANY is unpriced. */
export function sandboxRunUsd(sessions: readonly SandboxSessionFigures[]): number | undefined {
  if (sessions.length === 0) return undefined;
  let total = 0;
  for (const session of sessions) {
    const usd = sandboxSessionUsd(session);
    if (usd === undefined) return undefined;
    total += usd;
  }
  return round4(total);
}

/** How a run's cost was arrived at, best first. */
export type SandboxCostBasis = 'measured' | 'self_measured' | 'fallback';

/** What a compute ledger row records: a cost basis, or 'no_sandbox' for a run that provably never requested one. */
export type ComputeBasis = SandboxCostBasis | 'no_sandbox';

export interface SandboxRunCostOptions {
  /** The run's reserved compute amount; the fallback never settles below it. */
  reservedUsd?: number;
  /** Wall time from the sandbox request to now; the fallback's CPU bound uses it when given. */
  runWallMs?: number;
}

export const PINNED_MEMORY_MB = SANDBOX_PINNED_VCPUS * 2048;

/**
 * Tier 2: the provider's figures, with ONLY the missing CPU / egress filled from the in-VM counters.
 * Every result here rests on at least one figure that is ours (the pinned memory, our own wall time or
 * the counters), which is why the basis is never 'measured'. A region that is missing or has no rate
 * row is unpriced: no region is assumed.
 *
 * The counters are read BEFORE the stop, so the read-to-stop gap (up to 5 s plus the stop latency, and
 * longer on a cancel) is not counted. The reservation floor applied by `sandboxRunCost` bounds the effect.
 */
function selfMeasuredUsd(sessions: readonly SandboxSessionFigures[]): number | undefined {
  if (sessions.length === 0) return undefined;
  let total = 0;
  for (const s of sessions) {
    if (s.region === undefined || !PRICED_REGIONS.has(s.region)) return undefined;
    const wallMs = s.durationMs ?? s.ownDurationMs;
    if (!isFigure(wallMs)) return undefined;
    // A counter from a VM that restarted mid-session undercounts: refuse it.
    const own = s.selfMeasured;
    const ownOk =
      own !== undefined &&
      isFigure(own.cpuMs) &&
      isFigure(own.txBytes) &&
      // Above the physical bound the counters are forged or broken: reject (fall to the fallback), never clamp.
      own.cpuMs <= wallMs * SANDBOX_PINNED_VCPUS * SELF_MEASURED_CPU_TOLERANCE &&
      own.txBytes <= (wallMs / 1000) * MAX_EGRESS_BYTES_PER_SECOND &&
      (own.uptimeMs === undefined || (isFigure(own.uptimeMs) && own.uptimeMs >= wallMs - Math.max(SELF_MEASURED_RESET_MIN_SLACK_MS, SELF_MEASURED_RESET_SLACK_FRACTION * wallMs)));
    const cpuMs = isFigure(s.activeCpuMs) ? s.activeCpuMs : ownOk ? own.cpuMs : undefined;
    const txBytes = isFigure(s.egressBytes) ? s.egressBytes : ownOk ? own.txBytes : undefined;
    if (cpuMs === undefined || txBytes === undefined) return undefined;
    total += cpuTerm(cpuMs) + memoryTerm(isFigure(s.memoryMb) ? s.memoryMb : PINNED_MEMORY_MB, wallMs) + egressTerm(txBytes);
  }
  return round4(total);
}

/** Tier 3: 100% CPU on the pinned vCPUs for the whole time, memory exact, floored at the reservation.
 * It has NO egress term (egress is unknown here), so a genuine tier-2 reading with real egress may exceed it;
 * the floor at the reservation usually covers the gap. */
function fallbackUsd(sessions: readonly SandboxSessionFigures[], opts: SandboxRunCostOptions): number {
  let sessionWallMs = 0;
  let memory = 0;
  for (const s of sessions) {
    const wallMs = s.durationMs ?? s.ownDurationMs;
    if (!isFigure(wallMs)) continue;
    sessionWallMs += wallMs;
    memory += memoryTerm(isFigure(s.memoryMb) ? s.memoryMb : PINNED_MEMORY_MB, wallMs);
  }
  const cpuWallMs = isFigure(opts.runWallMs) ? opts.runWallMs : sessionWallMs;
  return Math.max(round4(SANDBOX_PINNED_VCPUS * cpuTerm(cpuWallMs) + memory), opts.reservedUsd ?? 0);
}

/**
 * A run's sandbox cost and how it was arrived at (the settle itself is CS-2's):
 *  1. 'measured': ONLY when every session has the provider's CPU, duration, egress, memory and region;
 *  2. 'self_measured': anything is ours, so ONLY the missing CPU / egress come from the in-VM
 *     counters (memory stays exact), floored at the reservation; an unpriced region is not assumed;
 *  3. 'fallback': both are missing, so the worst-case bound, floored at the reservation.
 */
export function sandboxRunCost(sessions: readonly SandboxSessionFigures[], opts: SandboxRunCostOptions = {}): { usd: number; basis: SandboxCostBasis } {
  const measured = sandboxRunUsd(sessions);
  if (measured !== undefined) return { usd: measured, basis: 'measured' };
  const own = selfMeasuredUsd(sessions);
  // Tier-2 figures are advisory (a forged LOW reading looks like an idle VM), so they never settle below the reservation.
  if (own !== undefined) return { usd: Math.max(own, opts.reservedUsd ?? 0), basis: 'self_measured' };
  return { usd: fallbackUsd(sessions, opts), basis: 'fallback' };
}
