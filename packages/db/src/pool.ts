import { Pool, type PoolConfig } from 'pg';

/**
 * Thin wrapper over `pg.Pool`. Kept as a single function rather than a class
 * so callers can create as many pools as they need (an admin/migration pool
 * plus an app_user pool) without any hidden shared state.
 */
export function createPool(connectionString: string, overrides: PoolConfig = {}): Pool {
  return new Pool({ connectionString, ...overrides });
}
