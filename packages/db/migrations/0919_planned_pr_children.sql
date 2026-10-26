-- D#483 S5-b2b: Planned PRs. A person's approval of a Spec that carries a Planned PRs table (spec_versions.frontmatter.planned_prs, written by the Spec step
-- from rows the pipeline checked) creates one child work item per row.
--
--   1. work_items gains planned_pr_key and planned_pr_spec_version_id: the child's key and the Spec version it was created from. A key matches the same
--      pattern the pipeline uses and may not start with fix- or check- (the driver's own sub-item keys). One child per (parent, key): a unique index, so a
--      repeated or concurrent approval, or a second writer, cannot make a duplicate. Only the approval definer may set either column, and nobody may change
--      them afterwards (a trigger), so a child's key cannot be forged from the web tier's table-wide INSERT.
--   2. planned_pr_children_create(parent, spec version) is called by work_item_approval_insert (0906's single writer, replaced below with one added call)
--      after it writes the approval row, with the Spec version that row names. It reads that version's table, re-checks every key, title and the row count in
--      the data, and inserts the children with ON CONFLICT DO NOTHING. It refuses (raises, so the approval rolls back) a version that is not the parent's, is
--      erased, or holds a table that is not an array of valid rows: nothing partial is ever created. A table with fewer than two rows creates nothing.
--      Children copy the parent's repo, kind and provenance (so an external item's children stay external). They start at triaged with no run: launching them
--      is a later step. Approvals made before this migration have no children and are not backfilled.
--   3. The approval definer role gains exactly the columns it needs: SELECT on the parent's repo/kind/provenance and the new columns, INSERT on the eight
--      columns above, SELECT on spec_versions.frontmatter, and an INSERT policy confined to the tenant.
--
-- Expand-only: two nullable columns, an index, a trigger and a function; rolling the code back leaves columns nothing reads. Numbered 0919: main's highest is
-- 0918; re-check against main right before merging. Neon shape: packages/db/neon-shape.d/0919_planned_pr_children.conf.

ALTER TABLE work_items
  ADD COLUMN planned_pr_key text,
  ADD COLUMN planned_pr_spec_version_id uuid;
ALTER TABLE work_items
  ADD CONSTRAINT work_items_planned_pr_key_check
    CHECK (planned_pr_key IS NULL OR (planned_pr_key ~ '^[a-z0-9-]{1,32}$' AND planned_pr_key !~ '^(fix|check)-')),
  ADD CONSTRAINT work_items_planned_pr_version_needs_key CHECK (planned_pr_spec_version_id IS NULL OR planned_pr_key IS NOT NULL),
  ADD CONSTRAINT work_items_planned_pr_spec_version_fk
    FOREIGN KEY (account_id, planned_pr_spec_version_id) REFERENCES spec_versions (account_id, id) ON DELETE SET NULL (planned_pr_spec_version_id);
CREATE UNIQUE INDEX work_items_planned_pr_once ON work_items (account_id, parent_id, planned_pr_key) WHERE planned_pr_key IS NOT NULL;

CREATE FUNCTION work_items_planned_pr_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (NEW.planned_pr_key IS NOT NULL OR NEW.planned_pr_spec_version_id IS NOT NULL) AND current_user <> 'work_item_approval_definer' THEN
      RAISE EXCEPTION 'work_items: a planned PR is created only by a person''s approval' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.planned_pr_key IS DISTINCT FROM OLD.planned_pr_key
     OR (NEW.planned_pr_spec_version_id IS DISTINCT FROM OLD.planned_pr_spec_version_id AND NEW.planned_pr_spec_version_id IS NOT NULL) THEN
    RAISE EXCEPTION 'work_items: a planned PR key and Spec version do not change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER work_items_planned_pr_guard BEFORE INSERT OR UPDATE ON work_items FOR EACH ROW EXECUTE FUNCTION work_items_planned_pr_guard();

GRANT SELECT (repo_id, kind, provenance, parent_id, planned_pr_key, planned_pr_spec_version_id) ON work_items TO work_item_approval_definer;
GRANT INSERT (account_id, repo_id, kind, provenance, title, parent_id, planned_pr_key, planned_pr_spec_version_id) ON work_items TO work_item_approval_definer;
GRANT SELECT (frontmatter) ON spec_versions TO work_item_approval_definer;
CREATE POLICY work_item_approval_definer_insert ON work_items FOR INSERT TO work_item_approval_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- An invoker function: it runs as work_item_approval_definer, called only from work_item_approval_insert.
CREATE FUNCTION planned_pr_children_create(p_parent uuid, p_spec_version_id uuid)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  tbl   jsonb;
  n     integer;
  par   record;
  made  integer;
BEGIN
  IF acct IS NULL OR NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION 'planned_pr_children_create: no active account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_parent IS NULL OR p_spec_version_id IS NULL THEN
    RAISE EXCEPTION 'planned_pr_children_create: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The version must be this item's own, in this tenant, and not erased: the only table read is the approved version's.
  SELECT s.frontmatter -> 'planned_prs' INTO tbl FROM public.spec_versions s
   WHERE s.id = p_spec_version_id AND s.account_id = acct AND s.work_item_id = p_parent AND s.erased_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'planned_pr_children_create: the Spec version is not this work item''s' USING ERRCODE = 'no_data_found';
  END IF;
  IF tbl IS NULL THEN
    RETURN 0;
  END IF;
  IF jsonb_typeof(tbl) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'planned_prs_invalid' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  n := jsonb_array_length(tbl);
  IF n < 2 THEN
    RETURN 0;
  END IF;
  IF n > 12
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(tbl) e
                 WHERE NOT coalesce(jsonb_typeof(e) = 'object' AND jsonb_typeof(e -> 'key') = 'string' AND jsonb_typeof(e -> 'title') = 'string'
                                    AND (e ->> 'key') ~ '^[a-z0-9-]{1,32}$' AND (e ->> 'key') !~ '^(fix|check)-'
                                    AND char_length(e ->> 'title') BETWEEN 1 AND 120 AND (e ->> 'title') !~ '[[:cntrl:]|`]', false))
     OR (SELECT count(DISTINCT e ->> 'key') FROM jsonb_array_elements(tbl) e) <> n THEN
    RAISE EXCEPTION 'planned_prs_invalid' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT w.repo_id, w.kind, w.provenance INTO par FROM public.work_items w WHERE w.id = p_parent AND w.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work item not found' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO public.work_items (account_id, repo_id, kind, provenance, title, parent_id, planned_pr_key, planned_pr_spec_version_id)
  SELECT acct, par.repo_id, par.kind, par.provenance, e.v ->> 'title', p_parent, e.v ->> 'key', p_spec_version_id
    FROM jsonb_array_elements(tbl) WITH ORDINALITY AS e (v, ord) ORDER BY e.ord
  ON CONFLICT (account_id, parent_id, planned_pr_key) WHERE planned_pr_key IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS made = ROW_COUNT;
  RETURN made;
END $$;
REVOKE ALL ON FUNCTION planned_pr_children_create(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION planned_pr_children_create(uuid, uuid) TO work_item_approval_definer;

-- work_item_approval_insert: 0906's body plus one call (after the approval row is written). Same signature, owner and grants.
CREATE OR REPLACE FUNCTION work_item_approval_insert(p_work_item_id uuid, p_by uuid, p_source text, p_with_spec boolean)
RETURNS TABLE (o_approval_id uuid, o_spec_version_id uuid, o_replayed boolean)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  env  uuid;
  cur  uuid;
  prev record;
  nid  uuid;
BEGIN
  IF acct IS NULL OR NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION 'work_item_approval: no active account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_work_item_id IS NULL OR p_by IS NULL OR p_source IS NULL OR p_source NOT IN ('proposal_approve', 'work_item_approve', 'reapprove_after_respec') THEN
    RAISE EXCEPTION 'work_item_approval: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = p_by) THEN
    RAISE EXCEPTION 'work_item_approval: the approver is not a member of this account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('work_item_approval:' || acct::text || ':' || p_work_item_id::text, 0));
  SELECT w.envelope_id INTO env FROM public.work_items w WHERE w.id = p_work_item_id AND w.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work item not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_with_spec THEN
    SELECT s.id INTO cur FROM public.spec_versions s
     WHERE s.account_id = acct AND s.work_item_id = p_work_item_id AND s.erased_at IS NULL ORDER BY s.version DESC LIMIT 1;
  END IF;
  SELECT a.id, a.approved_by, a.spec_version_id, a.source INTO prev FROM public.work_item_approvals a
   WHERE a.account_id = acct AND a.work_item_id = p_work_item_id ORDER BY a.created_at DESC, a.id DESC LIMIT 1;
  IF p_source = 'reapprove_after_respec' THEN
    IF prev.id IS NULL THEN
      RAISE EXCEPTION 'parent_not_approved' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF cur IS NULL THEN
      RAISE EXCEPTION 'no_spec' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;
  IF prev.id IS NOT NULL AND prev.approved_by = p_by AND prev.source = p_source AND prev.spec_version_id IS NOT DISTINCT FROM cur THEN
    RETURN QUERY SELECT prev.id, cur, true; RETURN;
  END IF;
  IF p_source = 'reapprove_after_respec' AND prev.spec_version_id IS NOT DISTINCT FROM cur THEN
    RAISE EXCEPTION 'not_respecced' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  INSERT INTO public.work_item_approvals (account_id, work_item_id, approved_by, spec_version_id, envelope_id, source)
  VALUES (acct, p_work_item_id, p_by, cur, env, p_source) RETURNING id INTO nid;
  -- D#483 S5-b2b: a person's approval of a Spec that carries a Planned PRs table creates the children, from THIS version and in this transaction, so the
  -- approval and its children commit or roll back together. A replay returned above and creates nothing. A proposal's approval has no Spec (cur is NULL).
  IF cur IS NOT NULL AND p_source IN ('work_item_approve', 'reapprove_after_respec') THEN
    PERFORM public.planned_pr_children_create(p_work_item_id, cur);
  END IF;
  RETURN QUERY SELECT nid, cur, false;
END $$;
