-- D#483 P3: work_item_driver_events, the stage driver's own record of what it decided, as facts a read route can show.
--
-- Why a table of its own. The things the Pipeline's insight view needs to say (the merge gate's outcome and the reasons
-- it gave, that the review status was posted, that a fix round started, pushed nothing or escalated, that a merge was
-- done by the gate, that a build could not start) are decisions of a long-running workflow, made well after the run
-- action that started it has settled:
--   * run_action_requests.outcome is written ONCE, when the request is performed ("started"); the review and the merge
--     come hours later, so there is nothing left to write it to.
--   * work_item_transitions records stages only, and several of these never move a stage (a merge gate that hands the
--     merge to a person, a fix round that pushed nothing, a review status posted).
--   * domain_events is the webhook and SSE outbox and is purged after 7 days.
-- A log line is not a fact a route can read, so each of these is a row here.
--
-- Shape. Fixed vocabulary only: `kind` is one of the listed words, `code` and each of `reasons` are plain snake_case
-- codes, `head_sha` is a hex commit id. There is no text column, so nothing a model, an issue author or a reviewer wrote
-- can be stored. Append-only (SELECT and INSERT for app_user, no UPDATE or DELETE), tenant-isolated exactly as
-- work_item_transitions is. `dedupe_key` makes a replayed workflow step a no-op: one row per
-- (work item, kind, dedupe_key), and the writer uses ON CONFLICT DO NOTHING.
--
-- No ownership bracket is needed: nothing here is a platform_ops-owned object (plain table and trigger function owned by
-- the migration role), the same shape 0610 has.

-- Every element is a plain snake_case code. (A joined-string regex would let one element carry a comma.)
CREATE FUNCTION work_item_driver_reasons_ok(r text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT cardinality(r) <= 20 AND NOT EXISTS (SELECT 1 FROM unnest(r) AS x WHERE x IS NULL OR x !~ '^[a-z][a-z0-9_]{0,63}$') $$;

-- Not executable by PUBLIC (only the login that writes the table needs it, for the CHECK below).
REVOKE ALL ON FUNCTION work_item_driver_reasons_ok(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work_item_driver_reasons_ok(text[]) TO app_user;

CREATE TABLE work_item_driver_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Order within one transaction, where created_at (the transaction's clock) ties.
  seq          bigint GENERATED ALWAYS AS IDENTITY,
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL,
  kind         text NOT NULL CONSTRAINT work_item_driver_events_kind_check CHECK (kind IN (
                 'build_refused', 'review_started', 'security_review_required', 'review_verdicts',
                 'fix_round_started', 'fix_round_refused', 'fix_pushed_nothing', 'fix_round_failed', 'escalated',
                 'review_status', 'merge_gate', 'merged_by_gate', 'stopped'
               )),
  code         text NULL CONSTRAINT work_item_driver_events_code_check CHECK (code ~ '^[a-z][a-z0-9_]{0,63}$'),
  reasons      text[] NOT NULL DEFAULT '{}'
                 CONSTRAINT work_item_driver_events_reasons_check CHECK (work_item_driver_reasons_ok(reasons)),
  head_sha     text NULL CONSTRAINT work_item_driver_events_head_check CHECK (head_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  pr_number    integer NULL CONSTRAINT work_item_driver_events_pr_check CHECK (pr_number > 0),
  round        smallint NULL CONSTRAINT work_item_driver_events_round_check CHECK (round BETWEEN 0 AND 20),
  run_id       uuid NULL,
  dedupe_key   text NOT NULL CONSTRAINT work_item_driver_events_dedupe_check CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  created_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE (account_id, work_item_id, kind, dedupe_key),
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id) ON DELETE SET NULL (run_id)
);

CREATE INDEX idx_work_item_driver_events_item ON work_item_driver_events (account_id, work_item_id, seq);

-- created_at is always the database's own clock, whatever an INSERT says.
CREATE FUNCTION work_item_driver_events_set_created_at() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER work_item_driver_events_set_created_at
  BEFORE INSERT ON work_item_driver_events
  FOR EACH ROW EXECUTE FUNCTION work_item_driver_events_set_created_at();

ALTER TABLE work_item_driver_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_item_driver_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work_item_driver_events TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
GRANT SELECT, INSERT ON work_item_driver_events TO app_user;
