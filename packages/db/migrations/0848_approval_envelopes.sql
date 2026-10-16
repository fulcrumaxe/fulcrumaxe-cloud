-- D#483 S5-d: the person's spend envelope for an approval, as an append-only history, and what the spend check needs to enforce it.
--
-- An envelope is the most one approval (a single item, a batch, or the weekly auto-start allowance) may spend. A change is a NEW ROW
-- with the next `version` of the same envelope `id`; the highest version is the current amount. Nothing is updated or deleted, so who set
-- what, and when, stays readable. `work_items.envelope_id` names the envelope an item draws on. reserve() reads it: an item with an
-- envelope is held to it (in place of the plan's Feature/Small cap), under a per-envelope lock, so two runs on one batch cannot both pass.
--
-- Three tables:
--   1. approval_envelopes      the versions. app_user holds SELECT and INSERT only. The insert policy ties `created_by` to the session's own
--                              user and requires that user to be an owner or admin, as 0830 does for the build-concurrency setting.
--   2. envelope_run_charges    a run that reserves no model money (a subscription or operator run) still counts against its envelope, at the
--                              run's estimated price (S5-p). One row per run, written by reserve() in the transaction that admits the run.
--                              A charge stops counting when its run never started (refused for spend, or cancelled before it began), so
--                              nothing is stamped to undo. SELECT and INSERT only.
--   3. envelope_pause_asks     the "raised once per item per envelope version" memory of the spend_past_envelope ask. Written on the same
--                              transaction that raises the ask. SELECT and INSERT only.
--
-- work_items.envelope_id has NO update grant for app_user (column grants since 0613): the setter belongs to the approval paths (S5-e1).
-- A plain column, not a foreign key, because an envelope's id repeats across its versions; reserve() fails closed on an id with no row.
--
-- Expand-only: new tables and one nullable column. Numbered above the highest migration claimed (0847 is held by an open PR).
-- Re-check against main right before merging.
CREATE TABLE approval_envelopes (
  id            uuid NOT NULL,
  account_id    uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id       uuid,
  scope         text NOT NULL CONSTRAINT approval_envelopes_scope_check CHECK (scope IN ('item', 'batch', 'weekly_autostart')),
  amount_usd    numeric(12, 4) NOT NULL CONSTRAINT approval_envelopes_amount_check CHECK (amount_usd >= 0),
  estimate_usd  numeric(12, 4) CONSTRAINT approval_envelopes_estimate_check CHECK (estimate_usd >= 0),
  margin_pct    numeric(6, 2) CONSTRAINT approval_envelopes_margin_check CHECK (margin_pct >= 0 AND margin_pct <= 500),
  version       integer NOT NULL CONSTRAINT approval_envelopes_version_check CHECK (version >= 1),
  created_by    uuid NOT NULL REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, id, version),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE
);

-- created_at is always the database's own clock, whatever an INSERT says.
CREATE FUNCTION approval_envelopes_set_created_at() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION approval_envelopes_set_created_at() FROM PUBLIC;
CREATE TRIGGER approval_envelopes_set_created_at
  BEFORE INSERT ON approval_envelopes
  FOR EACH ROW EXECUTE FUNCTION approval_envelopes_set_created_at();

ALTER TABLE approval_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_envelopes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_select ON approval_envelopes FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY tenant_isolation_insert ON approval_envelopes FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND created_by = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM account_members m
       WHERE m.account_id = approval_envelopes.account_id AND m.user_id = approval_envelopes.created_by AND m.role IN ('owner', 'admin')
    )
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
GRANT SELECT, INSERT ON approval_envelopes TO app_user;

ALTER TABLE work_items ADD COLUMN envelope_id uuid;
CREATE INDEX work_items_envelope_idx ON work_items (account_id, envelope_id) WHERE envelope_id IS NOT NULL;

CREATE TABLE envelope_run_charges (
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  run_id       uuid NOT NULL,
  envelope_id  uuid NOT NULL,
  usd          numeric(12, 4) NOT NULL CONSTRAINT envelope_run_charges_usd_check CHECK (usd > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, run_id),
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id) ON DELETE CASCADE
);
CREATE INDEX envelope_run_charges_envelope_idx ON envelope_run_charges (account_id, envelope_id);

CREATE TABLE envelope_pause_asks (
  account_id        uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  work_item_id      uuid NOT NULL,
  envelope_id       uuid NOT NULL,
  envelope_version  integer NOT NULL CONSTRAINT envelope_pause_asks_version_check CHECK (envelope_version >= 1),
  ask_id            uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, work_item_id, envelope_id, envelope_version),
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['envelope_run_charges', 'envelope_pause_asks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation_select ON %I FOR SELECT TO app_user
      USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)))$p$, t);
    EXECUTE format($p$CREATE POLICY tenant_isolation_insert ON %I FOR INSERT TO app_user
      WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)))$p$, t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO app_user', t);
  END LOOP;
END
$$;
