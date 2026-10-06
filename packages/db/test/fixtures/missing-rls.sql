-- Deliberate-failure fixture (D#2605 task H02): a table with no row-level
-- security at all. Used only by test/rls-inventory.test.ts to prove that
-- findRlsViolations() actually catches a violation -- never applied by
-- src/migrate.ts, never part of the real schema.
CREATE TABLE rls_violation_fixture (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);
