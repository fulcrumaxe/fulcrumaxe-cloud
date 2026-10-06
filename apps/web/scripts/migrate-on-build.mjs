#!/usr/bin/env node
// apps/web/scripts/migrate-on-build.mjs
//
// Staging: applies packages/db migrations during the Vercel build, before
// `next build`, when -- and only when -- FX_MIGRATE_ON_BUILD=1. It reuses the
// repo's own runner (packages/db/src/migrate.ts) and the owner-shape check
// (packages/db/src/ownerShape.ts); nothing new is written for migrating.
//
// - Flag unset (or "" / "0"): returns at once, before loading any database
//   code, so the build behaves exactly as it did before this script existed.
// - Connection string: DATABASE_URL_UNPOOLED, the direct (non-pooled) URL the
//   Neon Vercel integration injects. The pooled DATABASE_URL (PgBouncer,
//   transaction mode) is never used: the runner holds a session advisory lock.
// - The URL's role must have the owner shape docs/ops/hosted-postgres.md
//   describes, or the build fails before any migration statement runs.
// - Nothing printed here ever contains the URL or any part of its password:
//   messages are fixed text, and a caught error's text is scrubbed first.
//
// Run by apps/web's "prebuild" script with `node --experimental-strip-types`
// (the migration code is TypeScript); this file itself is plain JS.

import { pathToFileURL } from "node:url";

export const FLAG = "FX_MIGRATE_ON_BUILD";
export const URL_VAR = "DATABASE_URL_UNPOOLED";

const SHAPE_HELP = {
  role_not_found: "the connecting role or database could not be read from the catalog",
  not_login: "the role cannot log in",
  no_createrole: "the role lacks CREATEROLE",
  no_bypassrls: "the role lacks BYPASSRLS",
  not_database_owner: "the role does not own the database",
  is_superuser: "the role is a superuser",
};

export class MigrateOnBuildError extends Error {
  constructor(message) {
    super(message);
    this.name = "MigrateOnBuildError";
  }
}

/** Removes the URL and every secret-bearing part of it from `text`. */
export function scrub(text, url) {
  let out = String(text);
  const secrets = [url];
  try {
    const parsed = new URL(url);
    for (const part of [parsed.password, safeDecode(parsed.password), parsed.username, safeDecode(parsed.username), parsed.hostname]) {
      if (part) secrets.push(part);
    }
  } catch {
    // an unparseable URL is still removed whole above
  }
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out.length > 300 ? `${out.slice(0, 300)}...` : out;
}

/** Mirrors isPooledUrl in packages/api/src/sse/nudge.ts (not imported: that package is not loadable by plain Node here). Unparseable counts as pooled. */
function isPooledUrl(url) {
  try {
    return new URL(url).hostname.includes("-pooler");
  } catch {
    return true;
  }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function loadDb() {
  const dir = new URL("../../../packages/db/src/", import.meta.url);
  const [pool, migrate, shape] = await Promise.all([
    import(new URL("pool.ts", dir).href),
    import(new URL("migrate.ts", dir).href),
    import(new URL("ownerShape.ts", dir).href),
  ]);
  return { createPool: pool.createPool, runMigrations: migrate.runMigrations, checkOwnerShape: shape.checkOwnerShape };
}

/**
 * Returns { status: "skipped" } or { status: "migrated", applied: [...] }.
 * Throws MigrateOnBuildError (message safe to print) on any failure.
 */
export async function migrateOnBuild({ env = process.env, log = console.log, load = loadDb } = {}) {
  const flag = env[FLAG];
  if (flag === undefined || flag === "" || flag === "0") return { status: "skipped" };
  if (flag !== "1") throw new MigrateOnBuildError(`${FLAG} must be 1 to migrate, or unset; got an unrecognised value`);

  // A Preview-scoped flag must never run an unreviewed branch's migrations as the owner.
  if (env.VERCEL && env.VERCEL_ENV !== "production") {
    throw new MigrateOnBuildError(
      `${FLAG}=1 is only honoured on a Vercel Production build (VERCEL_ENV=production); this build is not. Remove the flag from this environment. The database was not touched.`,
    );
  }

  const url = env[URL_VAR];
  if (!url) {
    throw new MigrateOnBuildError(
      `${FLAG}=1 but ${URL_VAR} is not set. Connect the Neon integration to this project/environment so it injects the direct (non-pooled) URL. The database was not touched.`,
    );
  }

  if (isPooledUrl(url)) {
    throw new MigrateOnBuildError(
      `${URL_VAR} points at a pooled host (-pooler). Migrations need the direct connection string. The database was not touched.`,
    );
  }

  let pool;
  try {
    const db = await load();
    pool = db.createPool(url);
    // The error handler keeps a dropped idle connection from becoming an unhandled event.
    pool.on?.("error", () => {});

    let problems;
    try {
      problems = await db.checkOwnerShape(pool);
    } catch (err) {
      throw new MigrateOnBuildError(
        `could not read the owner role's shape from ${URL_VAR} (${scrub(err instanceof Error ? err.message : err, url)}). The database was not touched.`,
      );
    }
    if (problems.length > 0) {
      const reasons = problems.map((p) => SHAPE_HELP[p] ?? p).join("; ");
      throw new MigrateOnBuildError(
        `${URL_VAR} is not the migration owner role described in docs/ops/hosted-postgres.md: ${reasons}. The database was not touched.`,
      );
    }

    let result;
    try {
      result = await db.runMigrations(pool);
    } catch (err) {
      throw new MigrateOnBuildError(`migration failed: ${scrub(err instanceof Error ? err.message : err, url)}`);
    }
    log(`migrate-on-build: applied ${result.applied.length} migration(s)${result.applied.length ? `: ${result.applied.join(", ")}` : " (already up to date)"}`);
    return { status: "migrated", applied: result.applied };
  } finally {
    await pool?.end?.().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await migrateOnBuild();
  } catch (err) {
    console.error(`migrate-on-build: FAILED - ${err instanceof MigrateOnBuildError ? err.message : "unexpected error"}`);
    process.exit(1);
  }
}
