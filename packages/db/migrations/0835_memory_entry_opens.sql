-- D#601 MEM-4a1: "opened once before batching", enforced by the database. Text from a file in a repo (`import`) or from a runner transcript
-- (`runner_agent`) is the least trusted text in the review queue, and a batch approve is the quickest way to let it through unread. A control
-- whose job is to protect the queue from a hostile source cannot live only on the screen: a stale client, a script or a second tab would skip it.
--
--   memory_entry_opens     one row per (entry version, person): the person asked for that card, and the entry's content hash at that moment.
--                          Primary key (entry_id, user_id). An edit inserts a NEW row (a new id and a new hash), so the new version has no open
--                          record until its card is requested again. Rows go with the entry (ON DELETE CASCADE), so the 30 day purge leaves none.
--                          Forced RLS; app_user reads ITS OWN rows and cannot write; only the two functions below write it.
--   memory_mark_opened     the person asked for this card. Needs a user session and the same right to decide on the entry as memory_decide.
--                          Stores the entry's current content hash. Does nothing, and answers false, for an entry that is not `proposed` or
--                          whose author_kind is not `import` or `runner_agent` (nothing else is gated, so nothing else needs a record).
--   memory_decide_batch    approve or reject up to 20 entries in one transaction: all or nothing. It re-derives the caller's right for EVERY
--                          entry, requires one author_kind and one source for the whole batch (`mixed_sources`), and for `import` and
--                          `runner_agent` entries requires an open record by THIS caller whose hash equals the entry's current one
--                          (`must_open_first`, naming how many cards are unopened; nothing changes). It then decides each entry by calling
--                          memory_decide itself, so there is exactly one copy of the transition rules, the cap check and the audit row.
--
-- "Opened" means: the card for this exact version was requested by this person. It does not mean read. The threat model: this stops a mistaken
-- or scripted bulk approve and a client that skips the step. It does not stop a member who deliberately opens every card without reading it;
-- that member is the approver and can already approve cards one at a time. Opening changes no entry, so it needs no undo and writes no audit row.
--
-- A single-card approve is not gated: the card shows the whole body. The card's open request calls memory_mark_opened, so the single path leaves
-- the same record. D#601's rule that imported and runner-sourced proposals are never auto-approved is independent of this file.
--
-- "One source": the author_kind, and for an import the file the section came from (provenance.source_path). The agent, assistant and runner
-- kinds have no finer source: a batch of one kind is one source.
--
-- Batch decisions are `approved` and `rejected`: the two buttons of the queue card. The undo steps (back to proposed, retire, restore) stay on
-- memory_decide, one entry at a time, until the undo change (MEM-4b) gives a batch its single Undo.
--
-- Also here, one branch added to memory_edit: an edit of a version that already has a successor ends in `conflict` (unique_violation, which the core
-- layer maps to `conflict`), no longer `invalid_transition`. Two people editing the same version at once take turns on the row lock; the second one
-- reads the first one's result, a `superseded` row, and lost the race. memory_entries_successor_idx (one successor per entry, 0793) stays the
-- arbiter behind it. The function is otherwise byte for byte 0793's.
--
-- Roles: no new role. The functions are owned by memory_definer (0793), which gains column privileges on the one new table and nothing on
-- memory_entries. The migration role is made a member of memory_definer for the length of this file, as in 0793, and loses it at the end.
--
-- Expand only (a new table and functions; one function body replaced, none dropped). Numbered 0835 (reserved for MEM-4a1: 0831 to 0834 and 0836 to
-- 0839 belong to other changes); re-check against main's highest right before merging, and migrations merge in number order.

CREATE TABLE memory_entry_opens (
  account_id     uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  entry_id       uuid NOT NULL,
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  opened_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entry_id, user_id),
  FOREIGN KEY (account_id, entry_id) REFERENCES memory_entries (account_id, id) ON DELETE CASCADE
);
CREATE INDEX memory_entry_opens_user_idx ON memory_entry_opens (account_id, user_id);

ALTER TABLE memory_entry_opens ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_entry_opens FORCE ROW LEVEL SECURITY;

-- Read only, for the person whose rows they are, and only while they are a member of the account (a person removed from the account sees nothing).
GRANT SELECT (account_id, entry_id, user_id, content_sha256, opened_at) ON memory_entry_opens TO app_user;
CREATE POLICY own_rows_select ON memory_entry_opens FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM account_members am WHERE am.account_id = memory_entry_opens.account_id AND am.user_id = memory_entry_opens.user_id)
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

GRANT SELECT (account_id, entry_id, user_id, content_sha256),
      INSERT (account_id, entry_id, user_id, content_sha256, opened_at),
      UPDATE (content_sha256, opened_at) ON memory_entry_opens TO memory_definer;
CREATE POLICY memory_definer_select ON memory_entry_opens FOR SELECT TO memory_definer
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM account_members am WHERE am.account_id = memory_entry_opens.account_id AND am.user_id = memory_entry_opens.user_id)
  );
CREATE POLICY memory_definer_insert ON memory_entry_opens FOR INSERT TO memory_definer
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM account_members am WHERE am.account_id = memory_entry_opens.account_id AND am.user_id = memory_entry_opens.user_id)
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY memory_definer_update ON memory_entry_opens FOR UPDATE TO memory_definer
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM account_members am WHERE am.account_id = memory_entry_opens.account_id AND am.user_id = memory_entry_opens.user_id)
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM account_members am WHERE am.account_id = memory_entry_opens.account_id AND am.user_id = memory_entry_opens.user_id)
  );

-- Ownership bracket (0793's shape): the migrator needs SET on the role to create functions it owns and to replace memory_edit, and the role has
-- CREATE on public only for that. Both are reset at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'memory_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on memory_definer; cannot ALTER FUNCTION ... OWNER TO memory_definer';
    END IF;
    GRANT memory_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO memory_definer;

-- ---- memory_edit: the same function as 0793, with one added branch (see the header) ----------------------------------------
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
  IF NOT (
       (cur.scope = 'item' OR s.member_role IN ('owner', 'admin') OR (cur.status = 'proposed' AND cur.created_by = s.usr))
       AND (n_scope = 'item' OR s.member_role IN ('owner', 'admin') OR (NOT moved AND cur.status = 'proposed' AND cur.created_by = s.usr))
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

-- ---- memory_mark_opened -----------------------------------------------------------------------------------------------
CREATE FUNCTION memory_mark_opened(p_entry_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s   record;
  cur record;
BEGIN
  SELECT * INTO s FROM public.memory_session('memory_mark_opened', false);
  IF p_entry_id IS NULL THEN
    RAISE EXCEPTION 'invalid_message: an entry id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT e.id, e.scope, e.author_kind, e.status, e.body INTO cur
    FROM public.memory_entries e WHERE e.id = p_entry_id AND e.account_id = s.acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'memory_mark_opened: no such entry' USING ERRCODE = 'no_data_found';
  END IF;
  -- The same test as memory_decide: whoever may decide on the entry may open its card.
  IF cur.scope <> 'item' AND s.member_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'memory_mark_opened: only an owner or admin opens % entries', cur.scope USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF cur.status <> 'proposed' OR cur.author_kind NOT IN ('import', 'runner_agent') THEN
    RETURN false;
  END IF;
  -- An edit between the read above and this write leaves a hash that no longer matches the new version, which the batch check refuses.
  INSERT INTO public.memory_entry_opens (account_id, entry_id, user_id, content_sha256, opened_at)
  VALUES (s.acct, cur.id, s.usr, encode(sha256(convert_to(cur.body, 'UTF8')), 'hex'), clock_timestamp())
  ON CONFLICT (entry_id, user_id) DO UPDATE SET content_sha256 = EXCLUDED.content_sha256, opened_at = clock_timestamp();
  RETURN true;
END;
$$;

-- ---- memory_decide_batch ----------------------------------------------------------------------------------------------
CREATE FUNCTION memory_decide_batch(p_ids uuid[], p_decision text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s         record;
  found_n   integer;
  kinds_n   integer;
  sources_n integer;
  unopened  integer;
  decided   integer := 0;
  one       uuid;
BEGIN
  SELECT * INTO s FROM public.memory_session('memory_decide_batch', false);
  IF p_decision IS NULL OR p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'invalid_message: a batch approves or rejects' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RAISE EXCEPTION 'invalid_message: a batch needs at least one entry' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The pending cap of a scope is 20, so a batch never needs more.
  IF cardinality(p_ids) > 20 THEN
    RAISE EXCEPTION 'invalid_message: a batch holds at most 20 entries' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF array_position(p_ids, NULL) IS NOT NULL OR cardinality(p_ids) <> (SELECT count(DISTINCT x) FROM unnest(p_ids) AS x) THEN
    RAISE EXCEPTION 'invalid_message: a batch names each entry once' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Every row is locked, in id order (two batches cannot deadlock), before anything is read: what is checked below is what is decided.
  PERFORM 1 FROM public.memory_entries e WHERE e.id = ANY (p_ids) AND e.account_id = s.acct ORDER BY e.id FOR UPDATE;
  SELECT count(*) INTO found_n FROM public.memory_entries e WHERE e.id = ANY (p_ids) AND e.account_id = s.acct;
  IF found_n <> cardinality(p_ids) THEN
    RAISE EXCEPTION 'memory_decide_batch: no such entry' USING ERRCODE = 'no_data_found';
  END IF;
  IF s.member_role NOT IN ('owner', 'admin')
     AND EXISTS (SELECT 1 FROM public.memory_entries e WHERE e.id = ANY (p_ids) AND e.account_id = s.acct AND e.scope <> 'item') THEN
    RAISE EXCEPTION 'memory_decide_batch: only an owner or admin decides repo, account and role entries' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT count(DISTINCT e.author_kind), count(DISTINCT (e.author_kind, COALESCE(e.provenance ->> 'source_path', ''))) INTO kinds_n, sources_n
    FROM public.memory_entries e WHERE e.id = ANY (p_ids) AND e.account_id = s.acct;
  IF kinds_n > 1 OR sources_n > 1 THEN
    RAISE EXCEPTION 'mixed_sources: a batch holds one source' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT count(*) INTO unopened
    FROM public.memory_entries e
   WHERE e.id = ANY (p_ids) AND e.account_id = s.acct AND e.author_kind IN ('import', 'runner_agent')
     AND NOT EXISTS (
       SELECT 1 FROM public.memory_entry_opens o
        WHERE o.entry_id = e.id AND o.account_id = s.acct AND o.user_id = s.usr
          AND o.content_sha256 = encode(sha256(convert_to(e.body, 'UTF8')), 'hex'));
  IF unopened > 0 THEN
    RAISE EXCEPTION 'must_open_first: % of % cards have not been opened', unopened, cardinality(p_ids) USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- One copy of the rules: memory_decide re-derives the caller's right, checks the step and the scope cap, and writes the audit row. Any refusal
  -- (a full scope, an entry that is not proposed) rolls the whole batch back.
  FOREACH one IN ARRAY p_ids LOOP
    IF public.memory_decide(one, p_decision) = 'decided' THEN
      decided := decided + 1;
    END IF;
  END LOOP;
  RETURN decided;
END;
$$;

REVOKE ALL ON FUNCTION memory_mark_opened(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION memory_decide_batch(uuid[], text) FROM PUBLIC;
ALTER FUNCTION memory_mark_opened(uuid) OWNER TO memory_definer;
ALTER FUNCTION memory_decide_batch(uuid[], text) OWNER TO memory_definer;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner), to app_user alone.
GRANT EXECUTE ON FUNCTION memory_mark_opened(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION memory_decide_batch(uuid[], text) TO app_user;
REVOKE CREATE ON SCHEMA public FROM memory_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE memory_definer FROM CURRENT_USER;
  END IF;
END
$$;
