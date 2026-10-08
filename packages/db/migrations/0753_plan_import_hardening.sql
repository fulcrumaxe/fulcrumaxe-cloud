-- D#483 S3-H: two holes from the security review of the plan importer (0723).
--
-- 1. The importer's own role could change a proposal's owner_process while the row was still new, so a row owned by
--    the repo's own loop could be flipped to product and then approved. proposals_importer_guard now refuses ANY change
--    to an existing proposal's owner_process made as plan_importer, in every state: the owner is set when the row is
--    created and never moves under the importer. (The importer's upsert in packages/core no longer assigns the column on
--    conflict.)
-- 2. approve_proposal took the work item's id on trust. It now refuses unless the item belongs to the proposal's repo
--    (work_item_wrong_repo; an item that does not exist, or that belongs to another tenant, reads the same way) and is
--    still at triaged, the first stage and the only one the approve path creates (work_item_wrong_stage). Both refuse
--    with the same SQLSTATE as the other approve refusals (55000, object_not_in_prerequisite_state). The check comes
--    after the idempotent replay, so the same call twice is still the same answer.
--
-- Ownership is unchanged: proposals_importer_guard stays owned by the migration role (CREATE OR REPLACE keeps the owner),
-- approve_proposal stays SECURITY DEFINER owned by platform_ops with the same grants, and proposal_decider is not touched.
-- platform_ops is NOT given any new column of work_items: the work item's repo and stage are read by a one-purpose
-- definer, proposal_work_item_lookup, owned by the NOLOGIN role proposal_work_item_reader (0739's plan_kind_audit_writer
-- shape), which holds SELECT of four work_items columns under a policy bound to the caller's tenant. Giving platform_ops
-- the repo_id column itself changed what a platform_ops login sees on every query that touches the column (a refusal
-- became an empty result), and platform_ops would hold a read it only needs inside this one function.
-- Privilege brackets as in 0732.

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
  RETURN NEW;
END $$;

DO $$
DECLARE
  n text := 'proposal_work_item_reader';
  r record;
  bad text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    INTO r FROM pg_roles WHERE rolname = n;
  bad := '{}';
  IF r.rolcanlogin THEN bad := array_append(bad, 'rolcanlogin'); END IF;
  IF r.rolsuper THEN bad := array_append(bad, 'rolsuper'); END IF;
  IF r.rolcreatedb THEN bad := array_append(bad, 'rolcreatedb'); END IF;
  IF r.rolcreaterole THEN bad := array_append(bad, 'rolcreaterole'); END IF;
  IF r.rolreplication THEN bad := array_append(bad, 'rolreplication'); END IF;
  IF r.rolbypassrls THEN bad := array_append(bad, 'rolbypassrls'); END IF;
  IF array_length(bad, 1) > 0 THEN
    RAISE EXCEPTION 'role % still has privileged attribute(s): %', n, array_to_string(bad, ', ');
  END IF;
END
$$;

-- The reader holds the four columns the lookup returns or filters on, and sees only the caller's own tenant.
GRANT SELECT (id, account_id, repo_id, stage) ON work_items TO proposal_work_item_reader;
CREATE POLICY proposal_work_item_reader_select ON work_items FOR SELECT TO proposal_work_item_reader
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- Volatile on purpose: its owner could otherwise change the attribute, and the lookup must always see the live row.
CREATE FUNCTION proposal_work_item_lookup(p_work_item_id uuid) RETURNS TABLE (repo_id uuid, stage text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT w.repo_id, w.stage FROM public.work_items w
   WHERE w.id = p_work_item_id AND w.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
$$;
REVOKE ALL ON FUNCTION proposal_work_item_lookup(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION proposal_work_item_lookup(uuid) TO platform_ops;

-- Ownership bracket (0739's shape).
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'proposal_work_item_reader'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on proposal_work_item_reader; cannot ALTER FUNCTION ... OWNER TO proposal_work_item_reader';
    END IF;
    GRANT proposal_work_item_reader TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO proposal_work_item_reader;
ALTER FUNCTION proposal_work_item_lookup(uuid) OWNER TO proposal_work_item_reader;
REVOKE CREATE ON SCHEMA public FROM proposal_work_item_reader;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE proposal_work_item_reader FROM CURRENT_USER;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION approve_proposal(p_proposal_id uuid, p_work_item_id uuid)
RETURNS TABLE (state text, roadmap_position integer, work_item_id uuid, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr   uuid;
  p     public.proposals;
  pos   integer;
  w_repo  uuid;
  w_stage text;
  w_found boolean;
BEGIN
  usr := public.proposal_decider('approve_proposal');
  IF p_proposal_id IS NULL OR p_work_item_id IS NULL THEN
    RAISE EXCEPTION 'approve_proposal: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO p FROM public.proposals x WHERE x.id = p_proposal_id AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approve_proposal: proposal not found' USING ERRCODE = 'no_data_found';
  END IF;
  -- The same call twice (a retry) is the same answer and writes nothing.
  IF p.state = 'approved' AND p.work_item_id = p_work_item_id THEN
    RETURN QUERY SELECT p.state, p.roadmap_position, p.work_item_id, true; RETURN;
  END IF;
  IF p.state <> 'new' THEN
    RAISE EXCEPTION 'not_new' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- E5: the data would refuse it too (proposals_approved_needs_product); this gives the caller the code.
  IF p.owner_process <> 'product' THEN
    RAISE EXCEPTION 'owned_by_internal_loop' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.repos r WHERE r.id = p.repo_id AND r.account_id = acct AND r.installation_id IS NOT NULL) THEN
    RAISE EXCEPTION 'repo_not_connected' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- The work item is the caller's argument: it must be this proposal's repo's, and not yet started.
  SELECT true, l.repo_id, l.stage INTO w_found, w_repo, w_stage
    FROM public.proposal_work_item_lookup(p_work_item_id) l;
  IF w_found IS NOT TRUE OR w_repo IS DISTINCT FROM p.repo_id THEN
    RAISE EXCEPTION 'work_item_wrong_repo' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF w_stage IS DISTINCT FROM 'triaged' THEN
    RAISE EXCEPTION 'work_item_wrong_stage' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('proposal_position:' || p.repo_id::text, 0));
  SELECT COALESCE(max(x.roadmap_position), 0) + 1 INTO pos FROM public.proposals x WHERE x.repo_id = p.repo_id;
  BEGIN
    UPDATE public.proposals
       SET state = 'approved', decided_by_user_id = usr, decided_at = now(), roadmap_position = pos,
           work_item_id = p_work_item_id, updated_at = now()
     WHERE id = p.id AND account_id = acct;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'approve_proposal: that work item already belongs to a proposal' USING ERRCODE = 'unique_violation';
  END;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, COALESCE(usr::text, 'token:' || current_setting('app.token_id', true)), 'proposal.approved',
          jsonb_build_object('proposal_id', p.id, 'repo_id', p.repo_id, 'work_item_id', p_work_item_id, 'roadmap_position', pos),
          clock_timestamp());
  RETURN QUERY SELECT 'approved'::text, pos, p_work_item_id, false;
END $$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
