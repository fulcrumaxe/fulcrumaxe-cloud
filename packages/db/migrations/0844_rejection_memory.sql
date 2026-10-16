-- D#483 S5-f: rejection memory. A rejected proposal remembers whether it was "Not now" or "Never", and a "Not now" comes back.
--
-- Three nullable columns on proposals, and three changes to the decision definers:
--
--   reject_kind       'not_now' or 'never'; only on a rejected row. A rejected row decided before this migration has none and is
--                     treated as "Never" by every reader: it stays rejected, nothing resurfaces it.
--   resurface_after   the date a "Not now" may come back; present exactly when reject_kind is 'not_now'.
--   resurfaced_at     when a "Not now" came back to the inbox; only on a row that is no longer rejected. The decision stamp
--                     (decided_at, who) is kept on a resurfaced row so the card can say "You said not now on <date>"; the
--                     rejection note, which the 0723 CHECK ties to a rejected row, moves into the audit row.
--
-- Definers (all owned by platform_ops, as 0723 left them):
--   * reject_proposal(proposal, note, kind, resurface_after): the 0723 function plus the two new inputs. The two-argument
--     call of the previous deploy still resolves to it (kind defaults to 'never', which is what the old function meant), so a
--     rollback to the previous code keeps working. A "Not now" without a date gets 30 days; a date must be in the future and
--     at most 365 days away (22023 `invalid_resurface_date`).
--   * restore_proposal(proposal): "Move back to inbox" now also clears reject_kind and resurface_after.
--   * resurface_proposals(repo, import): new. Moves every `not_now` row of the repo whose date has passed AND whose source the
--     given import saw as still open back to `new`. "Source still open" is the importer's own fact, unchanged: the import wrote
--     last_import_id on the row (an issue, Discussion or plan task that is closed, done or gone is not written). A row whose
--     source is not one the importer reads (a preview or a docs finding) has no such fact and is never resurfaced. Called by the
--     import now, inside its own transaction, and by the daily sweep (S5-g2) later, always with the id of a RUNNING import of
--     that repo. EXECUTE goes to plan_importer only: a person's session, a token and the platform_ops login cannot call it.
--
-- Expand-only. DROP FUNCTION reject_proposal(uuid, text) is allowed because this file creates reject_proposal again (the
-- signature change). No column is dropped, renamed or made NOT NULL. The CHECKs are satisfied by every existing row (all three
-- columns are NULL on them).
--
-- Numbered above the highest migration claimed (0843 is reserved for S4-e2). Re-check against main right before merging.

ALTER TABLE proposals ADD COLUMN reject_kind text;
ALTER TABLE proposals ADD COLUMN resurface_after timestamptz;
ALTER TABLE proposals ADD COLUMN resurfaced_at timestamptz;
ALTER TABLE proposals
  ADD CONSTRAINT proposals_reject_kind_known
    CHECK (reject_kind IS NULL OR reject_kind IN ('not_now', 'never')),
  ADD CONSTRAINT proposals_reject_kind_only_when_rejected
    CHECK (reject_kind IS NULL OR state = 'rejected'),
  -- A date exactly with "Not now": a "Never" with a date, a "Not now" without one and a date without a kind are all refused.
  ADD CONSTRAINT proposals_resurface_after_iff_not_now
    CHECK ((reject_kind IS NOT DISTINCT FROM 'not_now') = (resurface_after IS NOT NULL)),
  ADD CONSTRAINT proposals_resurfaced_only_when_not_rejected
    CHECK (resurfaced_at IS NULL OR state <> 'rejected');

-- The definers write the three columns. plan_importer gets nothing on them: it reaches them only through resurface_proposals.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;
GRANT UPDATE (reject_kind, resurface_after, resurfaced_at) ON proposals TO platform_ops;

-- ---------------------------------------------------------------------
-- reject_proposal: the kind and the date.
-- ---------------------------------------------------------------------
DROP FUNCTION reject_proposal(uuid, text);
CREATE FUNCTION reject_proposal(p_proposal_id uuid, p_note text DEFAULT NULL, p_kind text DEFAULT 'never', p_resurface_after timestamptz DEFAULT NULL)
RETURNS TABLE (state text, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr   uuid;
  p     public.proposals;
  note  text := NULLIF(btrim(COALESCE(p_note, '')), '');
  kind  text := COALESCE(p_kind, 'never');
  after timestamptz;
BEGIN
  usr := public.proposal_decider('reject_proposal');
  IF p_proposal_id IS NULL OR (note IS NOT NULL AND char_length(note) > 500) OR kind NOT IN ('not_now', 'never')
     OR (kind = 'never' AND p_resurface_after IS NOT NULL) THEN
    RAISE EXCEPTION 'reject_proposal: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF kind = 'not_now' AND p_resurface_after IS NOT NULL AND (p_resurface_after <= now() OR p_resurface_after > now() + interval '365 days') THEN
    RAISE EXCEPTION 'invalid_resurface_date' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO p FROM public.proposals x WHERE x.id = p_proposal_id AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reject_proposal: proposal not found' USING ERRCODE = 'no_data_found';
  END IF;
  -- The same decision again is a replay: same note and kind, and for "Not now" the same date (or none given, which asks for the default).
  IF p.state = 'rejected' AND p.reject_note IS NOT DISTINCT FROM note
     AND COALESCE(p.reject_kind, 'never') = kind
     AND (kind = 'never' OR p_resurface_after IS NULL OR p.resurface_after = p_resurface_after) THEN
    RETURN QUERY SELECT p.state, true; RETURN;
  END IF;
  IF p.state <> 'new' THEN
    RAISE EXCEPTION 'not_new' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  after := CASE WHEN kind = 'not_now' THEN COALESCE(p_resurface_after, now() + interval '30 days') END;
  UPDATE public.proposals
     SET state = 'rejected', decided_by_user_id = usr, decided_at = now(), reject_note = note,
         reject_kind = kind, resurface_after = after, resurfaced_at = NULL, updated_at = now()
   WHERE id = p.id AND account_id = acct;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, COALESCE(usr::text, 'token:' || current_setting('app.token_id', true)), 'proposal.rejected',
          jsonb_build_object('proposal_id', p.id, 'repo_id', p.repo_id, 'kind', kind, 'resurface_after', after), clock_timestamp());
  RETURN QUERY SELECT 'rejected'::text, false;
END $$;

-- ---------------------------------------------------------------------
-- restore_proposal: "Move back to inbox" clears both fields.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION restore_proposal(p_proposal_id uuid)
RETURNS TABLE (state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid;
  p    public.proposals;
BEGIN
  usr := public.proposal_decider('restore_proposal');
  IF p_proposal_id IS NULL THEN
    RAISE EXCEPTION 'restore_proposal: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO p FROM public.proposals x WHERE x.id = p_proposal_id AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'restore_proposal: proposal not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p.state <> 'rejected' THEN
    RAISE EXCEPTION 'not_rejected' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  UPDATE public.proposals
     SET state = 'new', decided_by_user_id = NULL, decided_at = NULL, reject_note = NULL,
         reject_kind = NULL, resurface_after = NULL, updated_at = now()
   WHERE id = p.id AND account_id = acct;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, COALESCE(usr::text, 'token:' || current_setting('app.token_id', true)), 'proposal.restored',
          jsonb_build_object('proposal_id', p.id, 'repo_id', p.repo_id, 'kind', p.reject_kind), clock_timestamp());
  RETURN QUERY SELECT 'new'::text;
END $$;

-- ---------------------------------------------------------------------
-- resurface_proposals: the one place a "Not now" comes back.
-- ---------------------------------------------------------------------
CREATE FUNCTION resurface_proposals(p_repo_id uuid, p_import_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  n    integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'resurface_proposals: platform_ops may not call this directly' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION 'resurface_proposals: no active account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_repo_id IS NULL OR p_import_id IS NULL THEN
    RAISE EXCEPTION 'resurface_proposals: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Only inside a running import of this repo, so "still open" always means "this import just saw it".
  IF NOT EXISTS (SELECT 1 FROM public.plan_imports i
                  WHERE i.id = p_import_id AND i.account_id = acct AND i.repo_id = p_repo_id AND i.state = 'running') THEN
    RAISE EXCEPTION 'import_not_running' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- The note a "Not now" carried moves into the audit row: the 0723 CHECK allows a note only on a rejected row.
  WITH due AS (
    SELECT x.id, x.reject_note, x.resurface_after
      FROM public.proposals x
     WHERE x.account_id = acct AND x.repo_id = p_repo_id AND x.state = 'rejected' AND x.reject_kind = 'not_now'
       AND x.resurface_after <= now()
       AND x.last_import_id = p_import_id
       AND x.sources && ARRAY['plan_task', 'github_issue', 'github_discussion']::text[]
       FOR UPDATE OF x
  ), moved AS (
    UPDATE public.proposals x
       SET state = 'new', reject_note = NULL, reject_kind = NULL, resurface_after = NULL, resurfaced_at = now(), updated_at = now()
      FROM due
     WHERE x.id = due.id AND x.account_id = acct
    RETURNING x.id, due.reject_note AS old_note, due.resurface_after AS old_after
  ), logged AS (
    INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
    SELECT acct, 'system:plan_import', 'proposal.resurfaced',
           jsonb_build_object('proposal_id', m.id, 'repo_id', p_repo_id, 'import_id', p_import_id, 'resurface_after', m.old_after, 'note', m.old_note),
           clock_timestamp()
      FROM moved m
    RETURNING 1
  )
  SELECT count(*) INTO n FROM logged;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION reject_proposal(uuid, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION resurface_proposals(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reject_proposal(uuid, text, text, timestamptz) TO app_user;
GRANT EXECUTE ON FUNCTION resurface_proposals(uuid, uuid) TO plan_importer;
ALTER FUNCTION reject_proposal(uuid, text, text, timestamptz) OWNER TO platform_ops;
ALTER FUNCTION resurface_proposals(uuid, uuid) OWNER TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
