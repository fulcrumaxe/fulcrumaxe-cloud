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
