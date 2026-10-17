-- D#483 S4-d: what the issue webhook records when an outside author's new issue becomes a proposal, and the way an edited issue
-- sends its proposal back to be checked.
--
-- 1. proposal_intake_events: one row per (repository, issue number, outcome). The webhook writes `proposed` when it turned the
--    issue into a proposal and `proposal_rate_limited` when the repository had already taken its hourly cap and the issue was left
--    for the next discovery. It is both the hourly counter (the `proposed` rows of the last hour, per repository) and the
--    idempotency record: the UNIQUE key makes a replayed delivery, or the same issue delivered twice, write nothing a second time and
--    count once. The row holds no author, no title and no text of the issue: only the number, the outcome and the time.
--    app_user can read it and insert four columns; nothing is updated or deleted by app_user.
--
-- 2. proposal_requeue_verification(proposal): the one writer that sets a proposal's verification back to `pending` (an edited issue
--    has to be checked again). proposal_record_verification (0839) only records a verdict, and the verification columns are writable
--    by nobody else, so the re-queue is a second definer owned by the same NOLOGIN role (proposal_verification_definer), which
--    already holds exactly those columns and needs no new grant. It acts only on a proposal that is still `new`, clears the stamps
--    (verified_at, verified_sha, verified_run_id, verify_attempts) and never changes state, provenance or owner_process
--    (proposals_verification_guard from 0839 also refuses a write that mixes the two). It needs a tenant session of an active account
--    and refuses a token principal, as 0839 does.
--
-- Derived vs stamped: the hourly count is derived from the `proposed` rows on each delivery; nothing stores a counter. The
-- verification state after a re-queue is the column default again (`pending`), and "being checked" stays derived from it.
--
-- Expand-only: a new table and a new function; nothing existing changes, so the previous deploy runs on this schema.
-- Numbered above main's highest (0851) and the numbers open work holds (0852, 0853, 0856, 0858, 0859, 0860); re-checked before merge.
-- Ownership bracket as in 0839.
CREATE TABLE proposal_intake_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id    uuid NOT NULL,
  gh_number  integer NOT NULL CONSTRAINT proposal_intake_events_number_check CHECK (gh_number > 0),
  outcome    text NOT NULL CONSTRAINT proposal_intake_events_outcome_check CHECK (outcome IN ('proposed', 'proposal_rate_limited')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proposal_intake_events_once UNIQUE (repo_id, gh_number, outcome),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE
);
CREATE INDEX proposal_intake_events_recent ON proposal_intake_events (repo_id, outcome, created_at DESC);

ALTER TABLE proposal_intake_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposal_intake_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON proposal_intake_events TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)))
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
GRANT SELECT ON proposal_intake_events TO app_user;
GRANT INSERT (account_id, repo_id, gh_number, outcome) ON proposal_intake_events TO app_user;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'proposal_verification_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on proposal_verification_definer; cannot ALTER FUNCTION ... OWNER TO proposal_verification_definer';
    END IF;
    GRANT proposal_verification_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO proposal_verification_definer;

-- Answers true when the proposal was `new` and is pending again, false when it is in another state (nothing changes). Refusals: 42501 not
-- permitted, 22023 invalid argument, P0002 proposal not found.
CREATE FUNCTION proposal_requeue_verification(p_proposal_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  acct    uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  p_state text;
BEGIN
  IF acct IS NULL OR NOT account_is_active(acct) OR NULLIF(current_setting('app.token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'proposal_requeue_verification: a tenant session of an active account is required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_proposal_id IS NULL THEN
    RAISE EXCEPTION 'proposal_requeue_verification: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.state INTO p_state FROM public.proposals x WHERE x.id = p_proposal_id AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'proposal_requeue_verification: proposal not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_state <> 'new' THEN
    RETURN false;
  END IF;
  UPDATE public.proposals
     SET verification = 'pending', verified_at = NULL, verified_sha = NULL, verified_run_id = NULL, verify_attempts = 0
   WHERE id = p_proposal_id AND account_id = acct;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION proposal_requeue_verification(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION proposal_requeue_verification(uuid) TO app_user;
ALTER FUNCTION proposal_requeue_verification(uuid) OWNER TO proposal_verification_definer;

REVOKE CREATE ON SCHEMA public FROM proposal_verification_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE proposal_verification_definer FROM CURRENT_USER;
  END IF;
END
$$;
