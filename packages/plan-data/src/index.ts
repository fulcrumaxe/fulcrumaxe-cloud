import { planDataSchema, type PlanData } from './schema.js';

export { planDataSchema, type PlanData } from './schema.js';

/** The setting this module reads. */
export const PLAN_DATA_ENV = 'FX_PLAN_DATA';

/**
 * Plan data is unavailable: unset, unparsable, wrong shape, or a fixture in production.
 * Callers answer this with the "unavailable" state; there is no default to fall back to.
 */
export class PlanDataMissingError extends Error {
  readonly code = 'plan_data_unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'PlanDataMissingError';
  }
}

function fixtureAllowed(): boolean {
  const nodeEnv = process.env.NODE_ENV;
  return (nodeEnv === 'test' || nodeEnv === 'development') && process.env.VERCEL_ENV === undefined;
}

let cached: PlanData | undefined;

/** Forget the cached value (tests, and a process that wants to re-read the setting). */
export function resetPlanDataCache(): void {
  cached = undefined;
}

function pathOf(path: ReadonlyArray<string | number>): string {
  return path.length === 0 ? '(root)' : path.join('.');
}

/**
 * Read, parse and validate FX_PLAN_DATA, caching the result for the life of the process.
 * Messages name the variable, field path or key, and never include a value.
 */
export function loadPlanData(): PlanData {
  if (cached) return cached;
  const raw = process.env[PLAN_DATA_ENV];
  if (raw === undefined || raw.trim() === '') {
    throw new PlanDataMissingError(`${PLAN_DATA_ENV} is not set`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new PlanDataMissingError(`${PLAN_DATA_ENV} is not valid JSON`);
  }
  const parsed = planDataSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      if (issue.code === 'unrecognized_keys') {
        return `unknown key ${issue.keys.map((k) => pathOf([...issue.path, k])).join(', ')}`;
      }
      return `${pathOf(issue.path)}: ${issue.message}`;
    });
    throw new PlanDataMissingError(`${PLAN_DATA_ENV} is invalid: ${problems.join('; ')}`);
  }
  // Allowlist, not a production check: a fixture loads only where NODE_ENV is exactly test or development and no
  // Vercel deployment marker is present. Unset, staging, preview or any other value refuses it.
  if (parsed.data.fixture === true && !fixtureAllowed()) {
    throw new PlanDataMissingError(`${PLAN_DATA_ENV} holds the test fixture, which is only accepted in test and development`);
  }
  cached = parsed.data;
  return cached;
}

/** For health checks: never throws on bad data, never returns a value. */
export function planDataStatus(): 'ok' | 'missing' {
  try {
    loadPlanData();
    return 'ok';
  } catch (error) {
    if (error instanceof PlanDataMissingError) return 'missing';
    throw error;
  }
}

/**
 * D#483 S5-e1: `envelope.defaultMarginPct`, or null when plan data is unavailable or carries no such figure. Null is not a default: the caller pre-fills
 * the bare estimate and the health check reports `envelope_margin_unconfigured`. Never throws.
 */
export function envelopeDefaultMarginPct(): number | null {
  try {
    return loadPlanData().envelope?.defaultMarginPct ?? null;
  } catch (error) {
    if (error instanceof PlanDataMissingError) return null;
    throw error;
  }
}

export type DiscoverySettings =
  | { on: true; perRepoDailyUsd: number; verifyPerProposalUsd: number; externalVerifiesPerRepoPerDay: number; analysisPerRunUsd?: number }
  | { on: false; code: 'discovery_unconfigured' };

/**
 * D#483 S4-b: the `discovery.*` limits, read fail-closed. Plan data that is unavailable, or carries no `discovery` block, gives
 * `{ on: false, code: 'discovery_unconfigured' }`: discovery and verification are off for every repo and the health check reports the code.
 * There is no default figure. Never throws.
 */
export function discoverySettings(): DiscoverySettings {
  try {
    const d = loadPlanData().discovery;
    return d === undefined ? { on: false, code: 'discovery_unconfigured' } : { on: true, ...d };
  } catch (error) {
    if (error instanceof PlanDataMissingError) return { on: false, code: 'discovery_unconfigured' };
    throw error;
  }
}

export type AnalysisSettings = { on: true; perRepoDailyUsd: number; analysisPerRunUsd: number } | { on: false; code: 'analysis_unconfigured' };

/**
 * D#483 S4-f3: the docs-and-code analysis figures. Analysis is on only when the `discovery` block carries `analysisPerRunUsd`; otherwise
 * `{ on: false, code: 'analysis_unconfigured' }`, reported by the health check on its own line. Verification does not read this, so a missing
 * figure never turns it off. There is no default figure. Never throws on missing data.
 */
export function analysisSettings(): AnalysisSettings {
  const d = discoverySettings();
  if (!d.on || d.analysisPerRunUsd === undefined) return { on: false, code: 'analysis_unconfigured' };
  return { on: true, perRepoDailyUsd: d.perRepoDailyUsd, analysisPerRunUsd: d.analysisPerRunUsd };
}

/**
 * D#483 S5-k3b: the hosted sandbox slot total (`capacity.hostedSandboxConcurrency`). THROWS `PlanDataMissingError` when plan data is unavailable or carries
 * no such figure: nothing falls back to a number in code, and a start that cannot read the total must not guess one.
 */
export function hostedSandboxSlotTotal(): number {
  const c = loadPlanData().capacity;
  if (c === undefined) throw new PlanDataMissingError(`${PLAN_DATA_ENV} has no capacity.hostedSandboxConcurrency`);
  return c.hostedSandboxConcurrency;
}

/** For health checks: names what is missing, never throws on bad data, never returns a value. */
export function hostedSandboxCapacityStatus(): 'ok' | 'hosted_sandbox_capacity_unconfigured' {
  try {
    hostedSandboxSlotTotal();
    return 'ok';
  } catch (error) {
    if (error instanceof PlanDataMissingError) return 'hosted_sandbox_capacity_unconfigured';
    throw error;
  }
}
