// D#81: thin CLI wrapper so packages/db/scripts/test-neon-shape.sh (bash)
// can invoke the REAL packages/db/src/migrate.ts against an arbitrary
// connection string, without adding vitest (or any other package) as a
// new dependency. Run directly with Node's type-stripping
// (`node --experimental-strip-types`, Node 22+) -- that mode does not
// remap `.js` import specifiers onto sibling `.ts` files the way
// vitest's esbuild transform does for the rest of this package's test
// files, so the imports below use the real `.ts` extension instead of
// the `.js` extension used everywhere else in this package.
//
// Lives under scripts/, not test/, so `pnpm test`'s glob never picks it
// up (it is not a vitest spec and has no `describe`/`it`).
//
// D#81 fix round (security review, informational): <database-url> is an
// argv positional, which is visible to any other local user via the
// process list (`ps`) for as long as this process runs. That's fine for
// the trust-auth throwaway cluster test-neon-shape.sh points this at --
// never point this at a real Neon URL that carries a password.
//
// Usage: node --experimental-strip-types neon-shape-migrate.ts <database-url> [migrations-dir]
// Prints one line of JSON, {"applied": ["0001_core.sql", ...]}, to stdout.
// [migrations-dir] defaults to the real packages/db/migrations (via
// runMigrations's own default) -- test-neon-shape.sh overrides it only for
// the "fails on main" proof (D#81 criterion 1), which points this same
// runner at an unmodified checkout of origin/main's migrations instead of
// editing main itself.
// A migration failure propagates as a normal uncaught rejection: Node
// prints the error (including any Postgres error message/detail) to
// stderr and exits non-zero, which is what test-neon-shape.sh's
// criteria 1 and 5 grep for.
import { runMigrations } from '../src/migrate.ts';
import { createPool } from '../src/pool.ts';

const url = process.argv[2];
const migrationsDir = process.argv[3];
if (!url) {
  console.error('usage: neon-shape-migrate.ts <database-url> [migrations-dir]');
  process.exit(2);
}

const pool = createPool(url);
try {
  const result = migrationsDir
    ? await runMigrations(pool, migrationsDir)
    : await runMigrations(pool);
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}
