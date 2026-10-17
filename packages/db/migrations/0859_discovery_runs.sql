-- D#483 S4-c: one queued discovery per repository and trigger.
--
-- A discovery reads a repository's most recently updated open issues and Discussions and writes them as proposals (the inbox). It
-- starts from three triggers: the app installation was created, repositories were added to an installation, and the account's
-- subscription became active. This table is the queue and the idempotency record in one: a row says "this repository was asked to
-- be discovered because of this trigger", and the UNIQUE key (repo_id, trigger, trigger_ref) is what makes a replayed delivery or a
-- replayed Stripe event start nothing a second time. `trigger_ref` names the thing that caused it: `installation:<GitHub installation id>` for installation_created (the
-- webhook delivery and the install callback both queue it, whichever runs second is a no-op), the delivery id for repos_added, the Stripe subscription id for an activation (so the several events of one activation, checkout, invoice and
-- subscription update, are one discovery). A repository that is removed and added again arrives in a NEW delivery, so it is
-- discovered again; that is the "reconnecting re-derives new rows" rule.
--
-- No existing key sufficed: proposals carry no record of why or when they were read, and plan_imports belongs to a person's
-- start from the Plan view (one active import per repo, hourly limits), which an install must not compete with.
--
-- What is stamped and what is derived: state, skip_reason and counts are stamps (what this run saw and did). Whether a repo is on the
-- free preview, connected or switched off is NOT stored here; the run reads it when it starts and records only the reason it skipped.
--
-- Who writes: app_user, inside a tenant session, with column-scoped grants. It can queue a row (INSERT of four columns, always as
-- queued) and move its own state forward (queued to running, skipped or failed; running to succeeded, skipped or failed). Nothing is
-- ever deleted by app_user and a finished row is never changed. The run itself writes proposals as plan_importer, the role S3 gave
-- the import; this table gives that role nothing and creates no work item or agent run (the pg test counts them).
--
-- Expand-only: a new table. Numbered above main's highest and the numbers open PRs hold (0852 to 0858); re-checked before merge.
CREATE TABLE discovery_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id      uuid NOT NULL,
  trigger      text NOT NULL CONSTRAINT discovery_runs_trigger_check CHECK (trigger IN ('installation_created', 'repos_added', 'activation')),
  trigger_ref  text NOT NULL CONSTRAINT discovery_runs_trigger_ref_check CHECK (char_length(trigger_ref) BETWEEN 1 AND 200),
  state        text NOT NULL DEFAULT 'queued' CONSTRAINT discovery_runs_state_check CHECK (state IN ('queued', 'running', 'succeeded', 'skipped', 'failed')),
  skip_reason  text CONSTRAINT discovery_runs_skip_reason_check CHECK (skip_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  counts       jsonb CONSTRAINT discovery_runs_counts_check CHECK (jsonb_typeof(counts) = 'object'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  CONSTRAINT discovery_runs_once_key UNIQUE (repo_id, trigger, trigger_ref),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  CONSTRAINT discovery_runs_reason_iff_skipped CHECK ((state IN ('skipped', 'failed')) = (skip_reason IS NOT NULL)),
  CONSTRAINT discovery_runs_finished_iff_ended CHECK ((state IN ('succeeded', 'skipped', 'failed')) = (finished_at IS NOT NULL))
);
CREATE INDEX discovery_runs_queued ON discovery_runs (account_id, created_at) WHERE state = 'queued';

ALTER TABLE discovery_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON discovery_runs TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)))
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));

GRANT SELECT ON discovery_runs TO app_user;
GRANT INSERT (account_id, repo_id, trigger, trigger_ref) ON discovery_runs TO app_user;
GRANT UPDATE (state, skip_reason, counts, started_at, finished_at) ON discovery_runs TO app_user;

-- Legal moves only. A row starts queued; queued moves to running, skipped or failed; running moves to succeeded, skipped or failed;
-- an ended row never changes; identity columns never change.
CREATE FUNCTION discovery_runs_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'queued' THEN
      RAISE EXCEPTION 'discovery_runs: a run is queued first' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.account_id, NEW.repo_id, NEW.trigger, NEW.trigger_ref, NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.account_id, OLD.repo_id, OLD.trigger, OLD.trigger_ref, OLD.created_at)
     OR NOT ((OLD.state = 'queued' AND NEW.state IN ('running', 'skipped', 'failed'))
          OR (OLD.state = 'running' AND NEW.state IN ('succeeded', 'skipped', 'failed'))) THEN
    RAISE EXCEPTION 'discovery_runs: illegal change from %', OLD.state USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION discovery_runs_write_guard() FROM PUBLIC;
CREATE TRIGGER discovery_runs_write_guard BEFORE INSERT OR UPDATE ON discovery_runs
  FOR EACH ROW EXECUTE FUNCTION discovery_runs_write_guard();
