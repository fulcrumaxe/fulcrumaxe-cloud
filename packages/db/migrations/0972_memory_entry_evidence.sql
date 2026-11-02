-- D#601 MEM-9: the runs an agent-proposed role lesson cites as evidence. A lesson that worked in one repo "transfers poorly", so a role entry
-- proposed by an agent can be approved only when the runs behind it ran in at least two repositories. The repository of a run is NOT stored here:
-- it is read from the run (its work item's repository, else its dispatch repository) each time, so there is no stamp to go stale.
--
--   memory_entry_evidence   one row per (entry, run). The intake writes the proposing run's row with the entry, and one more row when a later run
--                           proposes the same wording for the same role (its second repository). Nothing updates a row; a row goes with its
--                           entry or its run (ON DELETE CASCADE). An edit makes a new version of the entry; the readers follow the version chain.
--                           Forced RLS. Members read their account's rows. Only a userless pipeline session may insert (no user in the session, and
--                           the session's user is no member of the account), so a person's session never adds evidence for a lesson.
--
-- No function is replaced and memory_definer gains nothing: the approval refusal ("Needs evidence from a second repo") is made in the core layer
-- before memory_decide is called. Expand only (one new table). Numbered 0972 (main's highest was 0970; 0971 is held by another change); re-check against main's highest right
-- before merging, and migrations merge in number order.

CREATE TABLE memory_entry_evidence (
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  entry_id    uuid NOT NULL,
  run_id      uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entry_id, run_id),
  FOREIGN KEY (account_id, entry_id) REFERENCES memory_entries (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id) ON DELETE CASCADE
);
CREATE INDEX memory_entry_evidence_run_idx ON memory_entry_evidence (account_id, run_id);

ALTER TABLE memory_entry_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_entry_evidence FORCE ROW LEVEL SECURITY;

GRANT SELECT (account_id, entry_id, run_id, recorded_at) ON memory_entry_evidence TO app_user;
GRANT INSERT (account_id, entry_id, run_id) ON memory_entry_evidence TO app_user;

CREATE POLICY tenant_isolation_select ON memory_entry_evidence FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY pipeline_insert ON memory_entry_evidence FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND NULLIF(current_setting('app.user_id', true), '') IS NULL
    AND NOT EXISTS (SELECT 1 FROM account_members am WHERE am.account_id = memory_entry_evidence.account_id AND am.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
