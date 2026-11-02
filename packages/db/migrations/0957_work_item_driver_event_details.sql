-- D#519 MQ4-d-0: the structured detail of a merge-conflict stop.
--
-- A `stopped` driver event carries only plain codes (0709 has no text column, on purpose). A card that says "It conflicts with {branch} in {files}" needs two
-- values that are not codes: the conflicted paths and the branch name. They go in this append-only table, one row per driver event, written in the same
-- transaction as the event. Both columns are checked here, so neither a model nor a pull request author can put free text in them.
--
-- Nothing is updated or deleted: `app_user` gets SELECT and INSERT only. The path rule is the conflict-round table's (0948 `merge_conflict_paths_ok`),
-- plus a byte cap per path. The writer (conflict.ts `isDetailPath` / `isDetailRef`) filters with the same rules before it writes, so a bad value is left out
-- instead of failing the stop; a test runs one corpus, and every code point, through both.

-- A composite key target, so the detail's account is the event's account (the cross-tenant FK rule).
ALTER TABLE work_item_driver_events ADD CONSTRAINT work_item_driver_events_account_id_key UNIQUE (account_id, id);

-- 0948's path rule (at most 100 paths of at most 512 characters, no absolute, home, drive, backslash, control, `.` or `..` form), and at most 1024 bytes each.
CREATE FUNCTION driver_event_paths_ok(p_paths text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT merge_conflict_paths_ok(p_paths) AND NOT EXISTS (SELECT 1 FROM unnest(p_paths) AS p(path) WHERE octet_length(p.path) > 1024)
$$;

-- A branch name git would accept: 1 to 255 bytes, no control or white space, no `..`, no leading `-`, none of ~ ^ : ? * [ \. Null passes (the column is nullable).
CREATE FUNCTION driver_event_ref_ok(p_ref text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT p_ref IS NULL OR (
    octet_length(p_ref) BETWEEN 1 AND 255
    AND p_ref !~ '[[:cntrl:][:space:]]' AND p_ref !~ ('[' || chr(128) || '-' || chr(159) || chr(8232) || chr(8233) || ']') AND strpos(p_ref, '..') = 0 AND p_ref !~ '^-' AND p_ref !~ '[~^:?*\[\\]'
  )
$$;

-- The CHECKs below run as the writing role (app_user), so it needs EXECUTE; PUBLIC does not.
REVOKE ALL ON FUNCTION driver_event_paths_ok(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION driver_event_ref_ok(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION driver_event_paths_ok(text[]) TO app_user;
GRANT EXECUTE ON FUNCTION driver_event_ref_ok(text) TO app_user;

CREATE TABLE work_item_driver_event_details (
  driver_event_id uuid PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  conflict_files  text[] NOT NULL DEFAULT '{}' CONSTRAINT work_item_driver_event_details_files_check CHECK (driver_event_paths_ok(conflict_files)),
  base_ref        text NULL CONSTRAINT work_item_driver_event_details_ref_check CHECK (driver_event_ref_ok(base_ref)),
  created_at      timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (account_id, driver_event_id) REFERENCES work_item_driver_events (account_id, id) ON DELETE CASCADE
);

-- created_at is the database's clock, whatever an INSERT says.
CREATE FUNCTION work_item_driver_event_details_set_created_at() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION work_item_driver_event_details_set_created_at() FROM PUBLIC;

CREATE TRIGGER work_item_driver_event_details_set_created_at
  BEFORE INSERT ON work_item_driver_event_details
  FOR EACH ROW EXECUTE FUNCTION work_item_driver_event_details_set_created_at();

ALTER TABLE work_item_driver_event_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_item_driver_event_details FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work_item_driver_event_details TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
REVOKE ALL ON work_item_driver_event_details FROM PUBLIC;
GRANT SELECT, INSERT ON work_item_driver_event_details TO app_user;
