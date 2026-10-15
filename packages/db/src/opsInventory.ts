import type { PoolClient } from 'pg';

/**
 * The views the operator console may read, by name. A view owned by `ops_owner` that is not listed here is a violation: each
 * later ops row adds its own view's name in the same change that creates it. Empty until the first ops view exists.
 */
export const OPS_VIEW_ALLOWLIST: readonly string[] = [];

/**
 * D#68 OPS-C1: the ops inventory. Returns one string per violation, empty when the schema is clean:
 *   `view:<name>:not_allowlisted`        a view owned by ops_owner that is not on the allowlist;
 *   `view:<name>:grant:<role>`           an allowlisted ops view with SELECT held (by grant, not by ownership) by any role other than
 *                                        ops_console; PUBLIC shows as `public`;
 *   `function:<signature>:not_definer`   an ops_owner function that is not SECURITY DEFINER;
 *   `function:<signature>:search_path`   an ops_owner function without a pinned search_path;
 *   `function:<signature>:execute:<who>` an ops_owner function whose EXECUTE reaches PUBLIC, app_user, platform_ops or partner_user.
 * `allowlist` is a parameter so a test can name a fixture view.
 */
export async function findOpsInventoryViolations(
  client: PoolClient,
  allowlist: readonly string[] = OPS_VIEW_ALLOWLIST,
): Promise<string[]> {
  const out: string[] = [];

  const { rows: views } = await client.query<{ relname: string }>(`
    SELECT c.relname
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relkind IN ('v', 'm')
      AND c.relowner = 'ops_owner'::regrole
    ORDER BY c.relname
  `);
  for (const v of views) {
    if (!allowlist.includes(v.relname)) out.push(`view:${v.relname}:not_allowlisted`);
  }

  const { rows: grants } = await client.query<{ relname: string; grantee: string }>(
    `
    SELECT c.relname, CASE WHEN a.grantee = 0 THEN 'public' ELSE pg_get_userbyid(a.grantee) END AS grantee
    FROM pg_class c, aclexplode(c.relacl) a
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relkind IN ('v', 'm')
      AND c.relowner = 'ops_owner'::regrole
      AND c.relname = ANY($1::text[])
      AND a.privilege_type = 'SELECT'
      AND a.grantee <> c.relowner
      AND a.grantee <> 'ops_console'::regrole
    ORDER BY c.relname, grantee
  `,
    [[...allowlist]],
  );
  for (const g of grants) out.push(`view:${g.relname}:grant:${g.grantee}`);

  const { rows: fns } = await client.query<{
    sig: string;
    prosecdef: boolean;
    pinned: boolean;
    public_exec: boolean;
    app_user_exec: boolean;
    platform_ops_exec: boolean;
    partner_user_exec: boolean;
  }>(`
    SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig,
           p.prosecdef,
           EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) cfg WHERE cfg LIKE 'search_path=%') AS pinned,
           has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
           has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user_exec,
           has_function_privilege('platform_ops', p.oid, 'EXECUTE') AS platform_ops_exec,
           has_function_privilege('partner_user', p.oid, 'EXECUTE') AS partner_user_exec
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proowner = 'ops_owner'::regrole
    ORDER BY p.oid
  `);
  for (const f of fns) {
    if (!f.prosecdef) out.push(`function:${f.sig}:not_definer`);
    if (!f.pinned) out.push(`function:${f.sig}:search_path`);
    if (f.public_exec) out.push(`function:${f.sig}:execute:public`);
    else {
      if (f.app_user_exec) out.push(`function:${f.sig}:execute:app_user`);
      if (f.platform_ops_exec) out.push(`function:${f.sig}:execute:platform_ops`);
      if (f.partner_user_exec) out.push(`function:${f.sig}:execute:partner_user`);
    }
  }
  return out;
}
