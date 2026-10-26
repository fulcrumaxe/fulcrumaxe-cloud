-- D#483 S5-b1a-3: the verifier's category is stored with its verdict, so the auto-start gate has a trusted source for an internal proposal.
--
-- Until now the only category on a proposal was `category_hint`, written by discovery; discovery rows are always external, which the gate never trusts,
-- so nothing could start unattended. S4-b's verifier already returns a `category` (parsed fail-closed); it was dropped on the floor. It is now kept in
-- `verifier_category`, written by `proposal_record_verification` in the same UPDATE as `verified_run_id`, and only when a run is named (a verified or
-- partly verified verdict): any other verdict, and any re-check, sets it back to NULL. Derived, not stamped: it can never outlive the verdict it
-- came from, because the same statement rewrites both, and `proposal_requeue_verification` clears `verified_run_id`, which the gate also requires.
-- The gate (packages/worker/src/autoStartSweep.ts) reads it for provenance = 'internal' proposals only, and only for small, bug or doc.
--
-- The definer's signature gains a trailing `p_category text DEFAULT NULL`, so the old six-argument function is dropped first (an overload with the
-- default would make a six-argument call ambiguous). A six-argument call from an old worker resolves to the new function through the default and records
-- the verdict with a NULL category, which the gate reads as "no verifier category" and so falls back to the hint (fails closed). The migration runs in one
-- transaction, so there is no moment between the DROP and the CREATE.
-- Numbered 0918: main's highest is 0916 and open PR #521 holds 0917. Ownership bracket as in 0839.

ALTER TABLE proposals
  ADD COLUMN verifier_category text CONSTRAINT proposals_verifier_category_check
    CHECK (verifier_category IN ('critical', 'feature', 'small', 'bug', 'doc', 'question', 'project'));
GRANT UPDATE (verifier_category) ON proposals TO proposal_verification_definer;

-- Provenance decides whether a model-chosen category can start work, so the import role may not change it (0723 granted it UPDATE on the column and the
-- 0753 guard only refused the owner). Body as in 0753, plus the provenance refusal. Owned by the migration role, as before.
CREATE OR REPLACE FUNCTION proposals_importer_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_user <> 'plan_importer' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'new' OR NEW.decided_at IS NOT NULL OR NEW.decided_by_user_id IS NOT NULL
       OR NEW.roadmap_position IS NOT NULL OR NEW.work_item_id IS NOT NULL OR NEW.reject_note IS NOT NULL THEN
      RAISE EXCEPTION 'proposals: an import may only create a new proposal' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
     AND NOT ((OLD.state = 'new' AND NEW.state = 'withdrawn') OR (OLD.state = 'withdrawn' AND NEW.state = 'new')) THEN
    RAISE EXCEPTION 'proposals: an import may not change a decision (% to %)', OLD.state, NEW.state USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.owner_process IS DISTINCT FROM OLD.owner_process THEN
    RAISE EXCEPTION 'proposals: an import may not change the owner of a proposal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.provenance IS DISTINCT FROM OLD.provenance THEN
    RAISE EXCEPTION 'proposals: an import may not change the provenance of a proposal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

-- The guard now covers the new column: a write that changes it never also changes a decision.
CREATE OR REPLACE FUNCTION proposals_verification_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.verification, NEW.verified_at, NEW.verified_sha, NEW.verify_attempts, NEW.verified_run_id, NEW.verifier_category)
       IS DISTINCT FROM (OLD.verification, OLD.verified_at, OLD.verified_sha, OLD.verify_attempts, OLD.verified_run_id, OLD.verifier_category)
     AND (NEW.state, NEW.provenance, NEW.owner_process) IS DISTINCT FROM (OLD.state, OLD.provenance, OLD.owner_process) THEN
    RAISE EXCEPTION 'proposals: a verification write may not change state, provenance or owner_process' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

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

DROP FUNCTION proposal_record_verification(uuid, text, text, uuid, jsonb, jsonb);
CREATE FUNCTION proposal_record_verification(
  p_proposal_id  uuid,
  p_verification text,
  p_verified_sha text,
  p_run_id       uuid,
  p_claims       jsonb DEFAULT '[]'::jsonb,
  p_evidence     jsonb DEFAULT '[]'::jsonb,
  p_category     text DEFAULT NULL)
RETURNS TABLE (verification_state text, attempts integer, claims_written integer, evidence_written integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  acct  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  p_repo     uuid;
  p_state    text;
  p_prov     text;
  p_owner    text;
  p_attempts integer;
  v_attempts integer;
  n_cl  integer;
  n_ev  integer;
  e     jsonb;
  k     text;
BEGIN
  IF acct IS NULL OR NOT account_is_active(acct) OR NULLIF(current_setting('app.token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'proposal_record_verification: a tenant session of an active account is required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_proposal_id IS NULL
     OR p_verification IS NULL OR p_verification NOT IN ('verified', 'partly_verified', 'refuted', 'not_checked', 'check_failed')
     OR (p_verification IN ('verified', 'partly_verified', 'refuted') AND p_verified_sha IS NULL)
     OR ((p_verification IN ('verified', 'partly_verified')) <> (p_run_id IS NOT NULL))
     OR p_claims IS NULL OR jsonb_typeof(p_claims) <> 'array' OR jsonb_array_length(p_claims) > 30
     OR p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'array' OR jsonb_array_length(p_evidence) > 30
     OR (p_category IS NOT NULL AND p_category NOT IN ('critical', 'feature', 'small', 'bug', 'doc', 'question', 'project')) THEN
    RAISE EXCEPTION 'proposal_record_verification: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(p_claims) x LOOP
    IF jsonb_typeof(e) <> 'object' OR NOT (e ?& ARRAY['text', 'verdict']) THEN
      RAISE EXCEPTION 'proposal_record_verification: invalid claim' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    FOR k IN SELECT jsonb_object_keys(e) LOOP
      IF k NOT IN ('text', 'verdict', 'refute_code') THEN
        RAISE EXCEPTION 'proposal_record_verification: invalid claim' USING ERRCODE = 'invalid_parameter_value';
      END IF;
    END LOOP;
    IF jsonb_typeof(e -> 'text') <> 'string' OR jsonb_typeof(e -> 'verdict') <> 'string'
       OR (e ? 'refute_code' AND jsonb_typeof(e -> 'refute_code') NOT IN ('string', 'null')) THEN
      RAISE EXCEPTION 'proposal_record_verification: invalid claim' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END LOOP;
  FOR e IN SELECT x FROM jsonb_array_elements(p_evidence) x LOOP
    IF jsonb_typeof(e) <> 'object' OR NOT (e ?& ARRAY['kind', 'ref', 'excerpt']) THEN
      RAISE EXCEPTION 'proposal_record_verification: invalid evidence' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    FOR k IN SELECT jsonb_object_keys(e) LOOP
      IF k NOT IN ('kind', 'ref', 'excerpt', 'commit_sha') THEN
        RAISE EXCEPTION 'proposal_record_verification: invalid evidence' USING ERRCODE = 'invalid_parameter_value';
      END IF;
    END LOOP;
    IF jsonb_typeof(e -> 'kind') <> 'string' OR jsonb_typeof(e -> 'ref') <> 'string' OR jsonb_typeof(e -> 'excerpt') <> 'string'
       OR (e ? 'commit_sha' AND jsonb_typeof(e -> 'commit_sha') NOT IN ('string', 'null')) THEN
      RAISE EXCEPTION 'proposal_record_verification: invalid evidence' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END LOOP;

  SELECT x.repo_id, x.state, x.provenance, x.owner_process, x.verify_attempts
    INTO p_repo, p_state, p_prov, p_owner, p_attempts
    FROM public.proposals x WHERE x.id = p_proposal_id AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'proposal_record_verification: proposal not found' USING ERRCODE = 'no_data_found';
  END IF;

  DELETE FROM public.proposal_claims WHERE proposal_id = p_proposal_id AND account_id = acct;
  DELETE FROM public.proposal_evidence WHERE proposal_id = p_proposal_id AND account_id = acct;
  INSERT INTO public.proposal_claims (proposal_id, account_id, text, verdict, checked_sha, checked_at, refute_code)
  SELECT p_proposal_id, acct, c ->> 'text', c ->> 'verdict',
         CASE WHEN c ->> 'verdict' = 'pending' THEN NULL ELSE p_verified_sha END,
         CASE WHEN c ->> 'verdict' = 'pending' THEN NULL ELSE now() END,
         c ->> 'refute_code'
    FROM jsonb_array_elements(p_claims) c;
  GET DIAGNOSTICS n_cl = ROW_COUNT;
  INSERT INTO public.proposal_evidence (account_id, repo_id, proposal_id, kind, ref, excerpt, commit_sha)
  SELECT acct, p_repo, p_proposal_id, v ->> 'kind', v ->> 'ref', v ->> 'excerpt', v ->> 'commit_sha'
    FROM jsonb_array_elements(p_evidence) v;
  GET DIAGNOSTICS n_ev = ROW_COUNT;

  -- Consecutive failed checks: a failure adds one, any real verdict resets it, and "not checked" (nothing was attempted) leaves it.
  v_attempts := CASE p_verification WHEN 'check_failed' THEN p_attempts + 1 WHEN 'not_checked' THEN p_attempts ELSE 0 END;
  UPDATE public.proposals
     SET verification = p_verification, verified_at = now(), verified_sha = p_verified_sha,
         verify_attempts = v_attempts, verified_run_id = p_run_id,
         verifier_category = CASE WHEN p_run_id IS NOT NULL THEN p_category END
   WHERE id = p_proposal_id AND account_id = acct;

  -- Belt and braces with proposals_verification_guard: this call never moves a decision.
  IF EXISTS (SELECT 1 FROM public.proposals x
              WHERE x.id = p_proposal_id AND (x.state, x.provenance, x.owner_process) IS DISTINCT FROM (p_state, p_prov, p_owner)) THEN
    RAISE EXCEPTION 'proposal_record_verification: a verification may not change state, provenance or owner_process' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT p_verification, v_attempts, n_cl, n_ev;
END $$;

REVOKE ALL ON FUNCTION proposal_record_verification(uuid, text, text, uuid, jsonb, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION proposal_record_verification(uuid, text, text, uuid, jsonb, jsonb, text) TO app_user;
ALTER FUNCTION proposal_record_verification(uuid, text, text, uuid, jsonb, jsonb, text) OWNER TO proposal_verification_definer;

-- The re-queue also clears the stored category, so a re-queued row carries no verdict-derived value at all. Body as in 0904 plus that column.
-- Answers true when the proposal was `new` and is pending again, false when it is in another state (nothing changes). Refusals: 42501 not
-- permitted, 22023 invalid argument, P0002 proposal not found.
CREATE OR REPLACE FUNCTION proposal_requeue_verification(p_proposal_id uuid) RETURNS boolean
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
     SET verification = 'pending', verified_at = NULL, verified_sha = NULL, verified_run_id = NULL, verifier_category = NULL, verify_attempts = 0
   WHERE id = p_proposal_id AND account_id = acct;
  -- The verdicts and excerpts of the earlier check described the earlier text; they go in the same transaction as the reset, so nothing
  -- reads them between the re-queue and the next check. The next proposal_record_verification (0839) writes the fresh ones.
  DELETE FROM public.proposal_claims WHERE proposal_id = p_proposal_id AND account_id = acct;
  DELETE FROM public.proposal_evidence WHERE proposal_id = p_proposal_id AND account_id = acct;
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
