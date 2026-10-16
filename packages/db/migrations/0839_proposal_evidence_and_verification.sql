-- D#483 S4-a: what a proposal rests on, and whether it was checked.
--
-- A proposal (0723) is one idea in the inbox. This migration adds the three things the claim verifier (S4-b), the discovery
-- sources (S4-c/d/f/g) and the Inbox (S4-h) all read, and nothing that runs yet:
--
--   * proposals.sources and proposals.dedupe_key accept three more sources (docs, code, interview) and the `src:<16 hex>`
--     key those sources use. Only the two CHECKs are replaced (DROP then ADD in one transaction); every existing row already
--     satisfies the wider sets.
--   * proposals gets five columns: verification (pending, verified, partly_verified, refuted, not_checked, check_failed;
--     starts pending), verified_at, verified_sha, verify_attempts, and verified_run_id, the verifier run that set the current
--     verified or partly_verified verdict (S5's start gate anchors its receipt on it; the S5 audit correction).
--   * proposal_evidence: the excerpts a verdict rests on. proposal_claims: the claims a verifier extracted and its verdict
--     on each. Both are tenant tables with forced RLS and cascade away with their proposal (so removing a proposal, a repo
--     or an account leaves no orphan evidence).
--
-- Who writes: ONE definer, proposal_record_verification, is the only writer of the verification columns, of claim verdicts and
-- of evidence. It is owned by its own NOLOGIN role, proposal_verification_definer (the 0781 shape), which holds exactly the
-- columns it writes; platform_ops gains nothing. app_user, plan_importer and platform_ops hold no write grant on any of them,
-- so a direct UPDATE or INSERT fails on privileges. The definer
--   * needs an active account in context and refuses a token principal (the verifier is a system process in a tenant
--     session, never an API caller);
--   * replaces the proposal's claim and evidence sets as one unit: a verdict is what the system saw at one commit, so rows
--     from an earlier commit never sit beside a newer verdict;
--   * never changes state, provenance or owner_process. That is enforced twice: by the definer comparing the row before and
--     after, and by the proposals_verification_guard trigger, which refuses ANY update that changes a verification column
--     and a decision column together. (A person's decision and the system's reading of the evidence stay separate writes.)
--
-- verify_attempts counts CONSECUTIVE FAILED CHECKS, so the verifier can cap retries of a failing check: check_failed adds one;
-- verified, partly_verified and refuted reset it to 0; not_checked leaves it as it was. (A judgment call for the PM to confirm:
-- a lifetime count of checks would need the retry cap to come from another source.)
--
-- Derived vs stamped: verification and its stamps are what the verifier saw at a commit, so they are stamps. "Being checked"
-- and "Couldn't confirm" in the Inbox are derived from the column on each read; nothing here records them.
--
-- Expand-only: new columns carry a default, new tables are new, two CHECKs are widened. Nothing existing is dropped or
-- reshaped, so the previous deploy runs on this schema (docs/ops/runbooks/rollback.md). 0723, 0753, 0755 and 0758 are not
-- edited. Numbered above main's highest and the open and reserved numbers (0831-0838); re-check right before merging.
-- Ownership bracket as in 0781.

-- ---------------------------------------------------------------------
-- 1. Wider source and key sets.
-- ---------------------------------------------------------------------
ALTER TABLE proposals DROP CONSTRAINT proposals_sources_check;
ALTER TABLE proposals
  ADD CONSTRAINT proposals_sources_check CHECK (cardinality(sources) >= 1
    AND sources <@ ARRAY['github_issue', 'github_discussion', 'plan_task', 'preview', 'docs', 'code', 'interview']::text[]);
ALTER TABLE proposals DROP CONSTRAINT proposals_dedupe_key_check;
ALTER TABLE proposals
  ADD CONSTRAINT proposals_dedupe_key_check CHECK (dedupe_key ~ '^(gh:issue:[0-9]+|gh:discussion:[0-9]+|plan:.{1,200}|src:[0-9a-f]{16})$');

-- ---------------------------------------------------------------------
-- 2. Verification columns.
-- ---------------------------------------------------------------------
ALTER TABLE proposals
  ADD COLUMN verification    text NOT NULL DEFAULT 'pending'
    CONSTRAINT proposals_verification_check CHECK (verification IN ('pending', 'verified', 'partly_verified', 'refuted', 'not_checked', 'check_failed')),
  ADD COLUMN verified_at     timestamptz,
  ADD COLUMN verified_sha    text CONSTRAINT proposals_verified_sha_check CHECK (char_length(verified_sha) BETWEEN 1 AND 64 AND verified_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  ADD COLUMN verify_attempts integer NOT NULL DEFAULT 0 CONSTRAINT proposals_verify_attempts_check CHECK (verify_attempts >= 0),
  ADD COLUMN verified_run_id uuid;
-- The run is kept by the same (account_id, id) shape as the ledger. A deleted run clears only this pointer.
ALTER TABLE proposals
  ADD CONSTRAINT proposals_verified_run_fk FOREIGN KEY (account_id, verified_run_id) REFERENCES agent_runs (account_id, id)
    ON DELETE SET NULL (verified_run_id);
-- A proposal is stamped once it has been checked, and only a verified or partly verified one names a run.
ALTER TABLE proposals
  ADD CONSTRAINT proposals_verification_stamped CHECK ((verification = 'pending') = (verified_at IS NULL)),
  ADD CONSTRAINT proposals_verified_run_only_when_verified CHECK (verified_run_id IS NULL OR verification IN ('verified', 'partly_verified'));

-- ---------------------------------------------------------------------
-- 3. Evidence and claims.
-- ---------------------------------------------------------------------
CREATE TABLE proposal_evidence (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id     uuid NOT NULL,
  proposal_id uuid NOT NULL,
  kind        text NOT NULL CONSTRAINT proposal_evidence_kind_check
    CHECK (kind IN ('file_lines', 'issue', 'discussion', 'doc_passage', 'interview_answer', 'preview')),
  ref         text NOT NULL CONSTRAINT proposal_evidence_ref_check CHECK (char_length(ref) BETWEEN 1 AND 300 AND ref !~ E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]'),
  -- Sanitised before insert (control characters other than tab, newline and carriage return are refused here). The text is a
  -- verbatim excerpt, so it is never rewritten: a stored excerpt must equal the bytes at its commit.
  excerpt     text NOT NULL CONSTRAINT proposal_evidence_excerpt_check
    CHECK (char_length(excerpt) <= 600 AND excerpt !~ E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]'),
  commit_sha  text CONSTRAINT proposal_evidence_commit_sha_check CHECK (char_length(commit_sha) BETWEEN 1 AND 64 AND commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, proposal_id) REFERENCES proposals (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  -- Lines of a file mean nothing without the commit they were read at.
  CONSTRAINT proposal_evidence_file_lines_need_sha CHECK (kind <> 'file_lines' OR commit_sha IS NOT NULL)
);
CREATE INDEX proposal_evidence_proposal ON proposal_evidence (proposal_id, created_at);

CREATE TABLE proposal_claims (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL,
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  text        text NOT NULL CONSTRAINT proposal_claims_text_check
    CHECK (char_length(text) BETWEEN 1 AND 400 AND text !~ E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]'),
  verdict     text NOT NULL DEFAULT 'pending' CONSTRAINT proposal_claims_verdict_check
    CHECK (verdict IN ('pending', 'supported', 'refuted', 'unverifiable')),
  checked_sha text CONSTRAINT proposal_claims_checked_sha_check CHECK (char_length(checked_sha) BETWEEN 1 AND 64 AND checked_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  checked_at  timestamptz,
  -- Why a claim was refuted, as a fixed code (never free text): the cited place is not in the commit's tree or lines, the lines
  -- exist but do not say it, or the source says the opposite.
  refute_code text CONSTRAINT proposal_claims_refute_code_check CHECK (refute_code IN ('cite_not_found', 'cite_mismatch', 'contradicted')),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, proposal_id) REFERENCES proposals (account_id, id) ON DELETE CASCADE,
  CONSTRAINT proposal_claims_refute_code_only_when_refuted CHECK (refute_code IS NULL OR verdict = 'refuted'),
  -- A claim is stamped once it has a verdict.
  CONSTRAINT proposal_claims_verdict_stamped CHECK ((verdict = 'pending') = (checked_at IS NULL))
);
CREATE INDEX proposal_claims_proposal ON proposal_claims (proposal_id);

-- ---------------------------------------------------------------------
-- 4. Row level security.
-- ---------------------------------------------------------------------
ALTER TABLE proposal_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposal_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE proposal_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposal_claims FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON proposal_evidence FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
CREATE POLICY tenant_isolation ON proposal_claims FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));

-- ---------------------------------------------------------------------
-- 5. The definer's role and its grants. app_user can read both tables and write neither; nobody else gains anything.
-- ---------------------------------------------------------------------
GRANT SELECT ON proposal_evidence, proposal_claims TO app_user;

DO $$
DECLARE
  n text := 'proposal_verification_definer';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'role % still has a privileged attribute', n;
  END IF;
END
$$;

-- Exactly what the body reads and writes, column by column (35 privileges). proposals: the row it locks and checks, and the five
-- verification columns. The two child tables: the columns it clears them by (account_id, proposal_id), the columns it inserts, and DELETE.
GRANT USAGE ON SCHEMA public TO proposal_verification_definer;
GRANT SELECT (id, account_id, repo_id, state, provenance, owner_process, verify_attempts),
      UPDATE (verification, verified_at, verified_sha, verify_attempts, verified_run_id) ON proposals TO proposal_verification_definer;
GRANT SELECT (account_id, proposal_id), INSERT (account_id, repo_id, proposal_id, kind, ref, excerpt, commit_sha), DELETE
  ON proposal_evidence TO proposal_verification_definer;
GRANT SELECT (account_id, proposal_id), INSERT (proposal_id, account_id, text, verdict, checked_sha, checked_at, refute_code), DELETE
  ON proposal_claims TO proposal_verification_definer;
GRANT SELECT (id, deleted_at) ON accounts TO proposal_verification_definer;

-- Every policy is bound to the caller's tenant; an inactive account writes nothing.
CREATE POLICY proposal_verification_definer_rw ON proposals FOR ALL TO proposal_verification_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
              AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
CREATE POLICY proposal_verification_definer_rw ON proposal_evidence FOR ALL TO proposal_verification_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
              AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
CREATE POLICY proposal_verification_definer_rw ON proposal_claims FOR ALL TO proposal_verification_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
              AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
-- account_is_active() reads the account row as the caller.
CREATE POLICY proposal_verification_definer_select ON accounts FOR SELECT TO proposal_verification_definer USING (true);

-- ---------------------------------------------------------------------
-- 6. Guard (owned by the migration role).
-- ---------------------------------------------------------------------
-- A write that changes what was verified never also changes a decision. No legitimate path does both: the decision definers
-- leave the verification columns alone, and the verification definer leaves the decision columns alone.
CREATE FUNCTION proposals_verification_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.verification, NEW.verified_at, NEW.verified_sha, NEW.verify_attempts, NEW.verified_run_id)
       IS DISTINCT FROM (OLD.verification, OLD.verified_at, OLD.verified_sha, OLD.verify_attempts, OLD.verified_run_id)
     AND (NEW.state, NEW.provenance, NEW.owner_process) IS DISTINCT FROM (OLD.state, OLD.provenance, OLD.owner_process) THEN
    RAISE EXCEPTION 'proposals: a verification write may not change state, provenance or owner_process' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER proposals_verification_guard BEFORE UPDATE ON proposals FOR EACH ROW EXECUTE FUNCTION proposals_verification_guard();

-- ---------------------------------------------------------------------
-- 7. The definer (SECURITY DEFINER, owner proposal_verification_definer, search_path pinned, EXECUTE for app_user only).
-- ---------------------------------------------------------------------
-- p_claims: [{text, verdict, refute_code?}], p_evidence: [{kind, ref, excerpt, commit_sha}], each at most 30 entries and no other keys.
-- A verified, partly_verified or refuted verdict names the commit it was read at; a verified or partly_verified one names its run.
-- Refusals: 42501 not permitted, 22023 invalid argument, P0002 proposal not found.
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

CREATE FUNCTION proposal_record_verification(
  p_proposal_id  uuid,
  p_verification text,
  p_verified_sha text,
  p_run_id       uuid,
  p_claims       jsonb DEFAULT '[]'::jsonb,
  p_evidence     jsonb DEFAULT '[]'::jsonb)
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
     OR p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'array' OR jsonb_array_length(p_evidence) > 30 THEN
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
         verify_attempts = v_attempts, verified_run_id = p_run_id
   WHERE id = p_proposal_id AND account_id = acct;

  -- Belt and braces with proposals_verification_guard: this call never moves a decision.
  IF EXISTS (SELECT 1 FROM public.proposals x
              WHERE x.id = p_proposal_id AND (x.state, x.provenance, x.owner_process) IS DISTINCT FROM (p_state, p_prov, p_owner)) THEN
    RAISE EXCEPTION 'proposal_record_verification: a verification may not change state, provenance or owner_process' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT p_verification, v_attempts, n_cl, n_ev;
END $$;

REVOKE ALL ON FUNCTION proposal_record_verification(uuid, text, text, uuid, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION proposal_record_verification(uuid, text, text, uuid, jsonb, jsonb) TO app_user;
ALTER FUNCTION proposal_record_verification(uuid, text, text, uuid, jsonb, jsonb) OWNER TO proposal_verification_definer;

REVOKE CREATE ON SCHEMA public FROM proposal_verification_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE proposal_verification_definer FROM CURRENT_USER;
  END IF;
END
$$;
