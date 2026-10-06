-- D#81: a deterministic, schema-only catalog listing for the public
-- schema, used to diff a Neon-shaped (non-superuser owner) migration
-- against a superuser-migrated one and prove they produced the same
-- schema. Every query is ORDER BY-sorted for a stable diff, and none of
-- them select an owner or grantor column -- those are EXPECTED to differ
-- between the two paths (the connecting role differs) and are not part of
-- what "the same schema" means here. The one deliberate exception is a
-- SECURITY DEFINER function's owner, which criterion 8 requires to be
-- platform_ops on both paths -- so it's included, but only for functions
-- where prosecdef is true (NULL for every ordinary, invoker-rights
-- function, whose owner may legitimately differ between the two roles
-- that ran the migration).
--
-- Run with `psql -X -q -v ON_ERROR_STOP=1 -A -F'|' -f neon-shape-catalog.sql`
-- (see test-neon-shape.sh) so the output is unaligned and pipe-delimited,
-- not column-width-aligned -- alignment padding would itself differ
-- between two otherwise-identical result sets if any single value's
-- display width happened to differ for an unrelated reason.

SELECT 'TABLE' AS section, tablename
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

SELECT 'COLUMN' AS section, table_name, column_name, ordinal_position, data_type,
       is_nullable, column_default, character_maximum_length, numeric_precision
FROM information_schema.columns
WHERE table_schema = 'public'
ORDER BY table_name, ordinal_position;

SELECT 'POLICY' AS section, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

SELECT 'RLS_ENABLED' AS section, c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relname;

SELECT 'TABLE_PRIVILEGE' AS section, grantee, table_name, privilege_type, is_grantable
FROM information_schema.table_privileges
WHERE table_schema = 'public'
  AND grantee IN ('app_user', 'platform_ops', 'partner_user')
ORDER BY table_name, grantee, privilege_type;

SELECT 'COLUMN_PRIVILEGE' AS section, grantee, table_name, column_name, privilege_type, is_grantable
FROM information_schema.column_privileges
WHERE table_schema = 'public'
  AND grantee IN ('app_user', 'platform_ops', 'partner_user')
ORDER BY table_name, column_name, grantee, privilege_type;

SELECT 'FUNCTION' AS section,
       p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       p.prosecdef,
       p.proconfig,
       CASE WHEN p.prosecdef THEN pg_get_userbyid(p.proowner) ELSE NULL END AS definer_owner,
       pg_get_function_result(p.oid) AS result_type,
       p.provolatile
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
ORDER BY p.proname, args;

SELECT 'FUNCTION_EXECUTE_GRANT' AS section, p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       a.privilege_type, a.grantee
FROM pg_proc p
JOIN LATERAL (
  SELECT (aclexplode(p.proacl)).*
) a ON true
JOIN pg_roles r ON r.oid = a.grantee
WHERE p.pronamespace = 'public'::regnamespace
  AND r.rolname IN ('app_user', 'platform_ops', 'partner_user')
ORDER BY p.proname, args, r.rolname, a.privilege_type;

SELECT 'TRIGGER' AS section, event_object_table, trigger_name, action_timing,
       event_manipulation, action_orientation, action_statement
FROM information_schema.triggers
WHERE trigger_schema = 'public'
ORDER BY event_object_table, trigger_name, event_manipulation;

SELECT 'CONSTRAINT' AS section, tc.table_name, tc.constraint_name, tc.constraint_type
FROM information_schema.table_constraints tc
WHERE tc.table_schema = 'public'
ORDER BY tc.table_name, tc.constraint_name;

SELECT 'CONSTRAINT_COLUMN' AS section, kcu.table_name, kcu.constraint_name,
       kcu.column_name, kcu.ordinal_position
FROM information_schema.key_column_usage kcu
WHERE kcu.table_schema = 'public'
ORDER BY kcu.table_name, kcu.constraint_name, kcu.ordinal_position;

SELECT 'CHECK_CONSTRAINT' AS section, cc.constraint_name, cc.check_clause
FROM information_schema.check_constraints cc
JOIN information_schema.table_constraints tc
  ON tc.constraint_name = cc.constraint_name AND tc.constraint_schema = cc.constraint_schema
WHERE cc.constraint_schema = 'public'
ORDER BY cc.constraint_name;

SELECT 'FK_TARGET' AS section, rc.constraint_name, rc.unique_constraint_name,
       rc.update_rule, rc.delete_rule
FROM information_schema.referential_constraints rc
WHERE rc.constraint_schema = 'public'
ORDER BY rc.constraint_name;

SELECT 'ROLE' AS section, rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
       rolcanlogin, rolreplication, rolbypassrls, rolconnlimit
FROM pg_roles
WHERE rolname IN ('app_user', 'platform_ops', 'partner_user')
ORDER BY rolname;
