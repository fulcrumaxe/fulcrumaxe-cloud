/**
 * D#600 CX-10a: whole milliseconds since a `performance.now()` reading (a monotonic clock), held inside the context ledger's range for the assembly time
 * (0 to 3,600,000). A reading that is not a finite number gives 0 rather than a refused write.
 */
export function assemblyMsSince(startedAt: number): number {
  return clampAssemblyMs(performance.now() - startedAt);
}

/** Whole milliseconds from a measured span (or the sum of two), held inside the ledger's range. */
export function clampAssemblyMs(elapsed: number): number {
  const ms = Math.round(elapsed);
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), 3_600_000) : 0;
}
