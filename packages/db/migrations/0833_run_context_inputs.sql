-- D#600 CX-8b: what a hosted run's prompt was given that the ledger's sections cannot say: WHICH memory entries were recalled into it, and WHICH repository
-- map it carried. The context panel (CX-8) shows both; before this nothing recorded either per run (the map cache keeps only the latest map of a
-- repository, and the recall stamps `last_recalled_at` without saying which run).
--
--   run_context_inputs  at most one row per run, written when the build run starts, in the same transaction that takes the build slot.
--     recalled_entry_ids / recalled_entry_versions
--                       the memory entries the prompt held, in prompt order, and each one's version (parallel arrays of equal length, at most 50).
--                       Names are NOT stored: the panel derives a name from the entry's own row at read time, so an entry that is deleted
--                       afterwards reads as "Deleted entry" and an edit never leaves an old name behind (a stamped name would).
--     map_version, map_sha256
--                       the repository map the prompt carried: its format version and the sha256 of the RAW map text (R-600-CX3b-1: the map's
--                       identity across sides is the raw-text hash, the same value as repo_context_maps.body_sha256). Both null, or both set.
--
-- Integers, ids and a hash only: no prompt text, no path. A run that recalled nothing and carried no map has no row (a fix round or a
-- continuation recalls nothing); the panel reads an absent row as "none recalled".
--
-- Access: app_user reads its own account's rows and inserts them; nothing updates or deletes (the row goes with its run, ON DELETE CASCADE).
-- platform_ops gets nothing. No definer: the writer is the build step in the account's own session, like repo_context_maps. This is derived,
-- low-trust display data; the reader re-shapes it, and what a run was actually given stays in the ledger's sections.
--
-- Written fail closed (D#601 C2). Expand only (a new table, nothing altered or dropped). Numbered 0833 (the queue holds 0831 and 0832); re-check against main right before merging.

CREATE TABLE run_context_inputs (
  account_id              uuid NOT NULL,
  run_id                  uuid NOT NULL,
  recalled_entry_ids      uuid[] NOT NULL DEFAULT '{}',
  recalled_entry_versions integer[] NOT NULL DEFAULT '{}',
  map_version             text CHECK (map_version IS NULL OR map_version ~ '^[0-9]{1,4}$'),
  map_sha256              text CHECK (map_sha256 IS NULL OR map_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, run_id),
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id) ON DELETE CASCADE,
  CHECK (cardinality(recalled_entry_ids) <= 50),
  CHECK (cardinality(recalled_entry_ids) = cardinality(recalled_entry_versions)),
  CHECK (array_position(recalled_entry_ids, NULL) IS NULL AND array_position(recalled_entry_versions, NULL) IS NULL),
  CHECK (1 <= ALL (recalled_entry_versions) AND 1000000 >= ALL (recalled_entry_versions)),
  CHECK ((map_version IS NULL) = (map_sha256 IS NULL))
);

-- "Used in N runs" (D#601 MEM-4a) asks which runs held an entry: a membership search over the array.
CREATE INDEX run_context_inputs_recalled_idx ON run_context_inputs USING gin (recalled_entry_ids);

ALTER TABLE run_context_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_context_inputs FORCE ROW LEVEL SECURITY;

GRANT SELECT (account_id, run_id, recalled_entry_ids, recalled_entry_versions, map_version, map_sha256, recorded_at) ON run_context_inputs TO app_user;
GRANT INSERT (account_id, run_id, recalled_entry_ids, recalled_entry_versions, map_version, map_sha256) ON run_context_inputs TO app_user;

CREATE POLICY tenant_isolation_select ON run_context_inputs FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY tenant_isolation_insert ON run_context_inputs FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
