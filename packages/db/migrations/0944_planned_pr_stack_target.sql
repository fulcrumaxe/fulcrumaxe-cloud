-- D#598 P3d: a planned PR child that depends on ONE sibling whose pull request is open starts at once and builds on that pull request, instead of waiting for the merge.
--
-- 0920's launch rule waited for every depends_on sibling to merge (check 5). This replaces planned_pr_child_waiting_on (CREATE OR REPLACE keeps its signature, owner and grants; planned_pr_child_blocker is unchanged) and adds two invoker functions for app_user. Nothing is stored: every answer is derived from the rows as they are now.
--
--   planned_pr_child_open_deps(child)    the depends_on keys whose sibling has not merged, in table order (0920's old body; the one place that reads the table).
--   planned_pr_child_stack_target(child) the sibling to build on, or NULL. Only when exactly ONE dependency is open, that sibling is in a stage that has a pull request
--                                        (pr_opened, changes_requested, review_passed), is not halted, is in the child's repo, and linking would not make a cycle.
--   planned_pr_child_waiting_on(child)   (replaced) the open dependencies, except that a stackable one no longer holds the child back.
--
-- A halted sibling, one in a person's hands (needs_human), a closed one, another repo and a cycle are all NULL: the child waits for the merge, as before. The link itself
-- is written by the launch through setStackParent (the one write path, which refuses a cycle or another repo again at the data). dial_launch_child does not read check 5
-- (it runs the blocker with p_skip_waiting), so no definer, grant or policy changes here.

CREATE FUNCTION planned_pr_child_open_deps(p_child uuid)
RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  c    record;
  out  text[];
BEGIN
  SELECT w.parent_id, w.planned_pr_key, w.planned_pr_spec_version_id INTO c FROM public.work_items w WHERE w.id = p_child AND w.account_id = acct;
  IF NOT FOUND OR c.planned_pr_key IS NULL OR c.parent_id IS NULL OR c.planned_pr_spec_version_id IS NULL THEN
    RETURN ARRAY[]::text[];
  END IF;
  SELECT coalesce(array_agg(d.dep ORDER BY d.ord), ARRAY[]::text[]) INTO out
    FROM (
      SELECT dd.dep, dd.ord
        FROM public.spec_versions s,
             LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.frontmatter -> 'planned_prs') = 'array' THEN s.frontmatter -> 'planned_prs' ELSE '[]'::jsonb END) AS e,
             LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(e -> 'depends_on') = 'array' THEN e -> 'depends_on' ELSE '[]'::jsonb END) WITH ORDINALITY AS dd (dep, ord)
       WHERE s.id = c.planned_pr_spec_version_id AND s.account_id = acct AND s.work_item_id = c.parent_id AND (e ->> 'key') = c.planned_pr_key
    ) d
   WHERE NOT EXISTS (SELECT 1 FROM public.work_items sib WHERE sib.account_id = acct AND sib.parent_id = c.parent_id AND sib.planned_pr_key = d.dep AND sib.stage = 'merged');
  RETURN out;
END $$;

CREATE FUNCTION planned_pr_child_stack_target(p_child uuid)
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  c    record;
  deps text[];
  sib  record;
BEGIN
  SELECT w.parent_id, w.repo_id INTO c FROM public.work_items w WHERE w.id = p_child AND w.account_id = acct;
  IF NOT FOUND OR c.parent_id IS NULL THEN
    RETURN NULL;
  END IF;
  deps := public.planned_pr_child_open_deps(p_child);
  IF cardinality(deps) <> 1 THEN
    RETURN NULL;
  END IF;
  SELECT s.id, s.repo_id, s.stage, s.halted_at INTO sib
    FROM public.work_items s WHERE s.account_id = acct AND s.parent_id = c.parent_id AND s.planned_pr_key = deps[1];
  IF NOT FOUND OR sib.halted_at IS NOT NULL OR sib.stage NOT IN ('pr_opened', 'changes_requested', 'review_passed') OR sib.repo_id IS DISTINCT FROM c.repo_id OR c.repo_id IS NULL THEN
    RETURN NULL;
  END IF;
  -- Linking must not make a cycle: the child may not already be in the sibling's stack.
  IF EXISTS (
    WITH RECURSIVE up(id) AS (
      SELECT sib.id
      UNION
      SELECT w.stack_parent_id FROM up u JOIN public.work_items w ON w.account_id = acct AND w.id = u.id WHERE w.stack_parent_id IS NOT NULL
    )
    SELECT 1 FROM up WHERE id = p_child
  ) THEN
    RETURN NULL;
  END IF;
  RETURN sib.id;
END $$;

CREATE OR REPLACE FUNCTION planned_pr_child_waiting_on(p_child uuid)
RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  deps text[] := public.planned_pr_child_open_deps(p_child);
BEGIN
  IF cardinality(deps) = 1 AND public.planned_pr_child_stack_target(p_child) IS NOT NULL THEN
    RETURN ARRAY[]::text[];
  END IF;
  RETURN deps;
END $$;

REVOKE ALL ON FUNCTION planned_pr_child_open_deps(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION planned_pr_child_stack_target(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION planned_pr_child_open_deps(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION planned_pr_child_stack_target(uuid) TO app_user;
