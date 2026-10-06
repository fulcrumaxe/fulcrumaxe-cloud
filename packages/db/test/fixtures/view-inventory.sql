-- D#45 S1 criterion 8 (D#68 PM correction): one object per lettered case
-- in the Spec's view/matview inventory check. Applied by
-- test/rls-inventory.test.ts, which asserts findRlsViolations()'s exact
-- expected set against this fixture, then drops everything it created
-- (see that test's cleanup query, mirroring test/fixtures/missing-rls.sql's
-- own apply-then-drop pattern).

CREATE TABLE view_inventory_fixture_base (id int PRIMARY KEY, val text);

-- (a) no option, granted to app_user: flagged.
CREATE VIEW view_inventory_fixture_a AS SELECT id, val FROM view_inventory_fixture_base;
GRANT SELECT ON view_inventory_fixture_a TO app_user;

-- (b) security_invoker = true: not flagged.
CREATE VIEW view_inventory_fixture_b WITH (security_invoker = true) AS
  SELECT id, val FROM view_inventory_fixture_base;
GRANT SELECT ON view_inventory_fixture_b TO app_user;

-- (c) security_invoker = on: not flagged.
CREATE VIEW view_inventory_fixture_c WITH (security_invoker = on) AS
  SELECT id, val FROM view_inventory_fixture_base;
GRANT SELECT ON view_inventory_fixture_c TO app_user;

-- (d) security_invoker = false: flagged.
CREATE VIEW view_inventory_fixture_d WITH (security_invoker = false) AS
  SELECT id, val FROM view_inventory_fixture_base;
GRANT SELECT ON view_inventory_fixture_d TO app_user;

-- (e) no option, granted only to PUBLIC: flagged (has_table_privilege for
-- app_user/partner_user is true via the PUBLIC grant).
CREATE VIEW view_inventory_fixture_e AS SELECT id, val FROM view_inventory_fixture_base;
GRANT SELECT ON view_inventory_fixture_e TO PUBLIC;

-- (f) no option (a definer view), granted only to a fixture NOLOGIN role
-- that is neither app_user nor partner_user: NOT flagged.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'view_inventory_fixture_role') THEN
    CREATE ROLE view_inventory_fixture_role NOLOGIN;
  END IF;
END
$$;
CREATE VIEW view_inventory_fixture_f AS SELECT id, val FROM view_inventory_fixture_base;
GRANT SELECT ON view_inventory_fixture_f TO view_inventory_fixture_role;

-- (g) a materialized view granted to partner_user: flagged.
CREATE MATERIALIZED VIEW view_inventory_fixture_g AS SELECT id, val FROM view_inventory_fixture_base;
GRANT SELECT ON view_inventory_fixture_g TO partner_user;

-- (h) a materialized view granted to no tenant role: not flagged.
CREATE MATERIALIZED VIEW view_inventory_fixture_h AS SELECT id, val FROM view_inventory_fixture_base;

-- (i) no option (owner's rights), column-only grant to partner_user: flagged.
CREATE VIEW view_inventory_fixture_i AS SELECT id, val FROM view_inventory_fixture_base;
GRANT SELECT (id) ON view_inventory_fixture_i TO partner_user;
