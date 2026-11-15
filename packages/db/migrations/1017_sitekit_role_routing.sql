-- Site kit's two model roles in the routing table (D#3 K05a, D#2 C12 item 4).
--
-- 1. The six rows for site-extractor and site-verifier go into every routing table version whose status is
--    'live' or 'proposed'. Retired and rejected versions are history and stay as they are. No existing row
--    changes (ON CONFLICT DO NOTHING keeps a re-run, or a version that already has a row, untouched). The
--    values are the provisional defaults until the accuracy benchmark; its result arrives as a new table
--    version, not as an edit to these rows. packages/model-router/default-table/v1.json carries the same
--    six rows, and test/tableSchema.test.ts fails if the JSON and the SQL seeds drift.
-- 2. site-verifier is floored at sonnet-5 (packages/model-router/src/floors.ts), so the role_settings floor
--    CHECK names it as well; packages/model-router/test/role-model-parity.test.ts fails if the two differ.
--    No role_settings row can name a site-kit role today, so no stored value can violate the wider list.
--
-- A new file, never an edit to a merged one (D#94 R1). The privilege bracket is copied from 0645.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

-- Both steps are guarded, because the repo's own upgrade-path fixtures apply this file before the migrations it
-- builds on (0010 routing tables and 0645 the role_settings floor CHECK are both held back there, since they landed
-- after others were already applied on real databases). Where the table or the constraint is not there yet, the
-- step is skipped: on a database that follows the real order both exist and both steps run.
DO $$
BEGIN
IF to_regclass('public.routing_rows') IS NOT NULL AND to_regclass('public.routing_tables') IS NOT NULL THEN
INSERT INTO routing_rows (table_version, role, size, model, rationale)
SELECT t.version, r.role, r.size, r.model, r.rationale
FROM routing_tables t
CROSS JOIN (VALUES
  ('site-extractor', 'Small', 'sonnet-5', 'site-kit role, provisional until the accuracy benchmark: a diff-scoped pass'),
  ('site-extractor', 'Feature', 'sonnet-5', 'site-kit role, provisional until the accuracy benchmark: a full pass'),
  ('site-extractor', 'Critical', 'opus-5', 'site-kit role, provisional until the accuracy benchmark: re-confirming a blocker'),
  ('site-verifier', 'Small', 'sonnet-5', 'site-kit role, provisional until the accuracy benchmark, floored at sonnet-5 for site-verifier: a diff-scoped pass'),
  ('site-verifier', 'Feature', 'opus-5', 'site-kit role, provisional until the accuracy benchmark, floored at sonnet-5 for site-verifier: a full pass'),
  ('site-verifier', 'Critical', 'opus-5', 'site-kit role, provisional until the accuracy benchmark, floored at sonnet-5 for site-verifier: re-confirming a blocker')
) AS r(role, size, model, rationale)
WHERE t.status IN ('live', 'proposed')
ON CONFLICT (table_version, role, size) DO NOTHING;
END IF;

IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.role_settings') AND conname = 'role_settings_model_floor') THEN
ALTER TABLE role_settings DROP CONSTRAINT role_settings_model_floor;
ALTER TABLE role_settings
  ADD CONSTRAINT role_settings_model_floor
    CHECK (model IS NULL OR role NOT IN ('security-reviewer', 'security-expert', 'site-verifier') OR model IN ('sonnet-5', 'opus-5'));
END IF;
END
$$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
