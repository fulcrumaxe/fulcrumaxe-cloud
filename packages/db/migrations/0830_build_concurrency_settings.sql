-- D#483 S5-c1: the person's own build-concurrency setting, as an append-only history.
--
-- Hosted builds have no product or plan-tier cap. How many items one account builds at once, and how many on one repository, is a
-- number the person sets. This table holds that number and every change to it:
--   * repo_id NULL   the account value (builds across all of the account's hosted repositories).
--   * repo_id set    that repository's value.
-- A change is a NEW ROW with the next `version` for its scope (the highest version is the current value). Nothing is updated or
-- deleted, so the history of who raised or lowered what, and the preview they were shown when they accepted it, stays readable.
-- `preview` is the cost preview the person accepted (S5-c2 writes it; the starting rows of S5-c1 never exist: no row means the
-- starting values, 2 per repository and 4 per account, which live in code as starting values, not in this table).
--
-- Derived state, not a stamp: the wait reason an item shows ("one build per repo until ...", "waiting for a build slot") is computed
-- from this table and the live item stages each time it is read. Nothing here records that an item is waiting.
--
-- Who may write: app_user holds SELECT and INSERT only (no UPDATE, no DELETE). The insert policy requires the row's account to be the
-- session's account and `changed_by` to be the session's own user AND that user to be an owner or admin of the account, so a row can neither
-- be written for another account nor attributed to another person, and a plain member or a userless session (the pipeline's tenant session) cannot insert. The route that writes it (S5-c2) adds
-- the owner-or-admin, session-only and explicit-accept rules.
--
-- Expand-only: a new table, nothing existing is changed. Numbered above the highest migration claimed (0798 is the queue's last).
-- Re-check against main right before merging.
CREATE TABLE build_concurrency_settings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id     uuid,
  max_builds  integer NOT NULL CONSTRAINT build_concurrency_settings_max_builds_check CHECK (max_builds >= 1),
  version     integer NOT NULL CONSTRAINT build_concurrency_settings_version_check CHECK (version >= 1),
  changed_by  uuid NOT NULL REFERENCES users (id),
  preview     jsonb NOT NULL DEFAULT '{}'::jsonb CONSTRAINT build_concurrency_settings_preview_check CHECK (jsonb_typeof(preview) = 'object'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE
);

-- One row per (scope, version): two writers racing to the same next version cannot both win.
CREATE UNIQUE INDEX build_concurrency_settings_account_version ON build_concurrency_settings (account_id, version) WHERE repo_id IS NULL;
CREATE UNIQUE INDEX build_concurrency_settings_repo_version ON build_concurrency_settings (account_id, repo_id, version) WHERE repo_id IS NOT NULL;

-- created_at is always the database's own clock, whatever an INSERT says.
CREATE FUNCTION build_concurrency_settings_set_created_at() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END;
$$;

-- Not executable by PUBLIC: platform_ops (a member of PUBLIC) must gain no EXECUTE. A trigger needs no EXECUTE grant to fire.
REVOKE ALL ON FUNCTION build_concurrency_settings_set_created_at() FROM PUBLIC;

CREATE TRIGGER build_concurrency_settings_set_created_at
  BEFORE INSERT ON build_concurrency_settings
  FOR EACH ROW EXECUTE FUNCTION build_concurrency_settings_set_created_at();

ALTER TABLE build_concurrency_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE build_concurrency_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_select ON build_concurrency_settings FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY tenant_isolation_insert ON build_concurrency_settings FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND changed_by = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM account_members m
       WHERE m.account_id = build_concurrency_settings.account_id AND m.user_id = build_concurrency_settings.changed_by AND m.role IN ('owner', 'admin')
    )
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
GRANT SELECT, INSERT ON build_concurrency_settings TO app_user;

-- One more kind in the driver's own fact store (work_item_driver_events, 0709; same widening as 0788): `build_waiting`, one row per poll of a build
-- that found no slot. Code and kind only, no text. The slot module counts an item as waiting only while its latest row is fresh, so a failed or
-- abandoned item stops holding a slot's place within a few polls. No grant moves.
ALTER TABLE work_item_driver_events DROP CONSTRAINT work_item_driver_events_kind_check;
ALTER TABLE work_item_driver_events
  ADD CONSTRAINT work_item_driver_events_kind_check CHECK (kind IN (
    'build_refused', 'build_waiting', 'review_started', 'security_review_required', 'review_verdicts',
    'fix_round_started', 'fix_round_refused', 'fix_pushed_nothing', 'fix_round_failed', 'escalated',
    'review_status', 'merge_gate', 'merged_by_gate', 'stopped', 'pr_head_pushed', 'platform_check', 'correction_applied'
  ));
