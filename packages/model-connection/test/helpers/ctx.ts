import type { Pool } from 'pg';
import type { ModelConnectionCtx, Principal } from '../../src/types.js';
import type { ValidationHttpClient } from '../../src/httpClient.js';
import type { KekSource } from '../../src/kek.js';

/** Curries the two pools (fixed per test file) so each test only supplies what varies: principal, httpClient, kek. */
export function ctxFactory(pool: Pool, platformOpsPool: Pool) {
  return (principal: Principal, httpClient: ValidationHttpClient, kek: KekSource): ModelConnectionCtx => ({
    pool,
    platformOpsPool,
    principal,
    httpClient,
    kek,
  });
}
