import type { Pool } from 'pg';

/**
 * The migration-owner shape docs/ops/hosted-postgres.md requires, read back
 * from the catalog for the role this connection actually runs as. Used by the
 * staging build (apps/web/scripts/migrate-on-build.mjs) to refuse to migrate
 * with the wrong credentials: a superuser URL, a role that does not own the
 * database, and so on.
 *
 * CREATEDB and REPLICATION are deliberately not checked. Neon gives every
 * connection owner membership in neon_superuser, which carries CREATEDB,
 * CREATEROLE, BYPASSRLS and REPLICATION, and the owner cannot drop them
 * (https://neon.com/docs/manage/roles). Only a true SUPERUSER is refused.
 *
 * Imports are type-only and there are no relative imports, so Node can load
 * this file directly with `--experimental-strip-types` during a build.
 */
export type OwnerShapeProblem =
  | 'role_not_found'
  | 'not_login'
  | 'no_createrole'
  | 'no_bypassrls'
  | 'not_database_owner'
  | 'is_superuser';

interface ShapeRow {
  rolcanlogin: boolean;
  rolcreaterole: boolean;
  rolbypassrls: boolean;
  rolsuper: boolean;
  owns_db: boolean;
}

/** Empty means the shape is right. Fails closed: a role or database that cannot be found is a problem. */
export async function checkOwnerShape(pool: Pick<Pool, 'query'>): Promise<OwnerShapeProblem[]> {
  const { rows } = await pool.query<ShapeRow>(
    `SELECT r.rolcanlogin, r.rolcreaterole, r.rolbypassrls, r.rolsuper,
            (d.datdba = r.oid) AS owns_db
       FROM pg_roles r
       JOIN pg_database d ON d.datname = current_database()
      WHERE r.rolname = current_user`,
  );
  const row = rows[0];
  if (!row) return ['role_not_found'];
  const problems: OwnerShapeProblem[] = [];
  if (row.rolcanlogin !== true) problems.push('not_login');
  if (row.rolcreaterole !== true) problems.push('no_createrole');
  if (row.rolbypassrls !== true) problems.push('no_bypassrls');
  if (row.owns_db !== true) problems.push('not_database_owner');
  if (row.rolsuper !== false) problems.push('is_superuser');
  return problems;
}
