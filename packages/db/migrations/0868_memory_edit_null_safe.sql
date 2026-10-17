-- D#601 MEM-4a2b: memory_edit let ANY member edit a pipeline-written proposal at repo or account scope. The rule (0793) is: owner or admin for
-- repo and account entries; a member edits only an entry they proposed themselves, while it is still waiting. A proposal the pipeline wrote (an
-- agent's, an import, a runner's) has created_by NULL, and `NULL = <the caller's id>` is NULL, not false. The test is `IF NOT (a AND b)`, and when
-- both halves came out NULL the IF saw NULL, which does not raise. So a member's edit of such a proposal went through: a new `proposed` version,
-- still fenced and still needing an owner or admin to approve it, but written by someone who may not touch repo memory.
--
-- The fix: "the caller proposed it" is computed once as a value that is never NULL (`created_by IS NOT NULL AND created_by = caller`) and the
-- test uses that. An approved entry was never reachable this way (`status = 'proposed'` is FALSE there, and FALSE AND NULL is FALSE), so nothing
-- already approved was exposed.
--
-- The function is otherwise byte for byte 0835's (which is 0793's plus the `conflict` branch). Nothing else changes: no table, no grant, no owner.
-- Expand only in effect (one function body replaced, none dropped). Numbered 0868 (0861 to 0867 belong to open or in-flight changes); re-check
-- against main's highest right before merging, and migrations merge in number order.

-- Ownership bracket (0793's shape): the migrator needs SET on the role to replace a function it owns, and the role has CREATE on public only for
-- that. Both are reset at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'memory_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on memory_definer; cannot replace memory_edit';
    END IF;
    GRANT memory_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO memory_definer;

CREATE OR REPLACE FUNCTION memory_edit(p_id uuid, p_body text, p_why text, p_kind text DEFAULT NULL, p_scope text DEFAULT NULL, p_scope_ref text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s       record;
  cur     record;
  new_id  uuid := gen_random_uuid();
  ts      timestamptz := clock_timestamp();
  n_scope text;
  n_ref   text;
  n_kind  text;
  moved   boolean;
  mine    boolean;
BEGIN
  SELECT * INTO s FROM public.memory_session('memory_edit', false);
  SELECT e.id, e.scope, e.scope_ref, e.kind, e.author_kind, e.provenance, e.status, e.version, e.created_by, e.expires_at INTO cur
    FROM public.memory_entries e WHERE e.id = p_id AND e.account_id = s.acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'memory_edit: no such entry' USING ERRCODE = 'no_data_found';
  END IF;
  n_scope := COALESCE(p_scope, cur.scope);
  -- Naming a new scope names its ref too (account takes none); otherwise the ref stays.
  n_ref := CASE WHEN p_scope IS NULL THEN cur.scope_ref ELSE p_scope_ref END;
  n_kind := COALESCE(p_kind, cur.kind);
  moved := n_scope <> cur.scope OR n_ref IS DISTINCT FROM cur.scope_ref;
  -- The caller proposed this entry and it is still waiting. Never NULL: a proposal the pipeline wrote has no created_by, and is nobody's "own".
  mine := cur.status = 'proposed' AND cur.created_by IS NOT NULL AND cur.created_by = s.usr;
  IF NOT (
       (cur.scope = 'item' OR s.member_role IN ('owner', 'admin') OR mine)
       AND (n_scope = 'item' OR s.member_role IN ('owner', 'admin') OR (NOT moved AND mine))
  ) THEN
    RAISE EXCEPTION 'memory_edit: not allowed to edit this entry here' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A version that already has a successor was edited by someone else while this call waited for the row: the same outcome as meeting the one-successor
  -- index (23505), reported the same way, as `conflict`.
  IF cur.status = 'superseded' THEN
    RAISE EXCEPTION 'memory_edit: that entry was edited by someone else' USING ERRCODE = 'unique_violation';
  END IF;
  IF cur.status NOT IN ('proposed', 'approved') THEN
    RAISE EXCEPTION 'invalid_transition: only a proposed or approved entry can be edited' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- author_kind is carried over unchanged: an edit never moves agent-origin bytes out of the fence.
  PERFORM public.memory_validate(n_scope, n_ref, n_kind, p_body, p_why, cur.author_kind, cur.provenance);
  IF n_scope = 'item' AND moved AND NOT EXISTS (SELECT 1 FROM public.work_items w WHERE w.id = n_ref::uuid AND w.account_id = s.acct) THEN
    RAISE EXCEPTION 'memory_edit: no such work item' USING ERRCODE = 'no_data_found';
  END IF;
  IF cur.status = 'approved' AND moved THEN
    PERFORM public.memory_assert_room(s.acct, n_scope, n_ref, cur.id);
  END IF;
  UPDATE public.memory_entries SET status = 'superseded', updated_at = ts WHERE id = cur.id AND account_id = s.acct;
  INSERT INTO public.memory_entries (id, account_id, scope, scope_ref, kind, body, why, author_kind, provenance, status, created_by, approved_by, approved_at, expires_at, version, supersedes_id, content_sha256)
  VALUES (new_id, s.acct, n_scope, n_ref, n_kind, p_body, p_why, cur.author_kind, cur.provenance, cur.status, s.usr,
          CASE WHEN cur.status = 'approved' THEN s.usr END, CASE WHEN cur.status = 'approved' THEN ts END, cur.expires_at,
          cur.version + 1, cur.id, encode(sha256(convert_to(p_body, 'UTF8')), 'hex'));
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (s.acct, s.usr::text, 'memory.edited',
          jsonb_build_object('entry_id', new_id, 'scope', n_scope, 'kind', n_kind, 'author_kind', cur.author_kind, 'from_status', cur.status,
                             'to_status', cur.status, 'version', cur.version + 1), ts);
  RETURN new_id;
END;
$$;

REVOKE CREATE ON SCHEMA public FROM memory_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE memory_definer FROM CURRENT_USER;
  END IF;
END
$$;
