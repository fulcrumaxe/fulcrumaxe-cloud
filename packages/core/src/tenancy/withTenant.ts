/**
 * Re-exported, not reimplemented: @fx/db's `withTenant` is the sole
 * sanctioned way any app_user-scoped query runs (it sets `app.account_id`
 * / `app.user_id` via `SET LOCAL` before handing the caller a client, and
 * resets both on the way out -- see packages/db/src/withTenant.ts).
 *
 * test/unit/poolQueryScan.test.ts enforces that nothing under src/ calls
 * `<somePool>.query(...)` directly outside this file and withPlatformOps.ts
 * -- every other module reaches Postgres only through one of these two,
 * never by holding a Pool and calling `.query` on it itself.
 */
export { withTenant } from '@fx/db/src/withTenant.js';
