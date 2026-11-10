-- D#749 V3c: a repository's browser driver for the post-merge deploy verifier, chosen on its verify settings.
--
-- `playwright` (the default: the runner's own Playwright browser) or `chrome` (Claude in Chrome on the runner; chosen only after the owner's smoke run shows the CLI attaches it with the runner's
-- credential). The stage reads it when it starts a tester job and signs the choice into the job as `browser_method`.
--
-- Expand-only: one column with a default and a closed check (plus, below, one more reason word in a check and one more rule in a guard), so every existing row reads `playwright` and the code that predates the column never names it. The write is the table's own admin
-- policy (owner or admin of the account, 1003): the column joins the same UPDATE grant, and INSERT already allows every column. No new function, no new policy. The number is the next
-- free one above main's highest (1006); merges go in number order and the Team Lead re-checks it at merge.

ALTER TABLE verify_settings ADD COLUMN browser_driver text NOT NULL DEFAULT 'playwright' CONSTRAINT verify_settings_browser_driver_check CHECK (browser_driver IN ('playwright', 'chrome'));
GRANT UPDATE (browser_driver) ON verify_settings TO app_user;

-- A reason for a row whose account cannot be judged (D#749 V3c): the stage judges the signed-in account from the envelope's `signed_in_as`, which only a playwright runner's verify server records. A row
-- driven by another method with a test account configured ends `unverified: account_unverifiable`. The check keeps 1003's list and gains the one word. (A check is replaced in place: every
-- existing row already holds a word the new list accepts, so the re-validation cannot fail.)
ALTER TABLE verify_rows DROP CONSTRAINT verify_rows_reason_check;
ALTER TABLE verify_rows ADD CONSTRAINT verify_rows_reason_check CHECK (reason_code IN (
  'no_browser', 'chrome_not_connected', 'wrong_account', 'sign_in_refused', 'deploy_failed', 'deployment_unreachable',
  'commit_not_deployed', 'envelope_rejected', 'hollow_pass', 'journey_blocked', 'journeys_missing', 'run_failed', 'verify_disabled', 'account_unverifiable'));

-- Defence in depth: a runner job that carries a browser method must carry a minimum protocol of 16, the way 0887 does for a check at 8. The claim already skips a job above the claiming runner's
-- protocol (0805), so a job without the minimum would be open to an older runner that cannot parse the key; the issuer sets it, and this refuses a first job write that forgot. The body is 0887's,
-- word for word, plus the one rule.
CREATE OR REPLACE FUNCTION agent_runs_runner_columns_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user = 'platform_ops' AND NEW.job_signed IS DISTINCT FROM OLD.job_signed THEN
    RAISE EXCEPTION 'agent_runs: platform_ops may not write job_signed; use agent_run_set_runner_job'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.initiated_by IS DISTINCT FROM OLD.initiated_by THEN
    RAISE EXCEPTION 'agent_runs.initiated_by is written at insert only (run %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.job_signed IS NOT NULL AND NEW.job_signed IS DISTINCT FROM OLD.job_signed THEN
    RAISE EXCEPTION 'agent_runs.job_signed is write-once (run %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- D#599 PL-2b-1: the job's lowest runner protocol is set with the job and never again.
  IF OLD.job_signed IS NULL AND NEW.job_signed IS NOT NULL THEN
    NEW.min_protocol_version := NULLIF(current_setting('fx.job_min_protocol', true), '')::integer;
    -- Defence in depth: a first write in the cross-side shape (a null session id, or a pull request number) with no minimum would be open to every runner.
    IF NEW.min_protocol_version IS NULL
       AND jsonb_typeof(NEW.job_signed #> '{job,continues}') = 'object'
       AND (jsonb_typeof(NEW.job_signed #> '{job,continues,session_id}') = 'null' OR (NEW.job_signed #> '{job,continues}') ? 'pr_number')
    THEN
      RAISE EXCEPTION 'agent_runs.job_signed in the cross-side shape needs a minimum protocol version (run %)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    -- D#6 R-CHK-1: the same for a job that carries the repo's approved check. Protocol 8 is the first whose runner can be given one (CHECK_JOB_MIN_PROTOCOL).
    IF jsonb_typeof(NEW.job_signed #> '{job,check}') = 'object' AND COALESCE(NEW.min_protocol_version, 0) < 8 THEN
      RAISE EXCEPTION 'agent_runs.job_signed with a check needs a minimum protocol version of 8 (run %)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    -- D#749 V3c: the same for a job that carries a browser method. Protocol 16 is the first whose runner can be given one (BROWSER_METHOD_JOB_MIN_PROTOCOL): an older runner's strict parse refuses the key.
    IF (NEW.job_signed #> '{job,browser_method}') IS NOT NULL AND COALESCE(NEW.min_protocol_version, 0) < 16 THEN
      RAISE EXCEPTION 'agent_runs.job_signed with a browser method needs a minimum protocol version of 16 (run %)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.min_protocol_version IS DISTINCT FROM OLD.min_protocol_version THEN
    RAISE EXCEPTION 'agent_runs.min_protocol_version is written with the job and never changed (run %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
