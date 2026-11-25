-- D#845 ON-27a2: closes the exclusion gaps left by 1097 and lets the repo sync connect a twin. Numbered 1099 by the Team Lead; never renumbered.
--   1. twin_record (restated from 1097) refuses a repo that is the OTHER role of a live twin (the public repo as some twin's private repo, or the reverse), and a repo whose full name
--      is some pairing's code_repo (that pairing already publishes it). Both answer as before: twin_exists and pairing_exists.
--   2. twin_record, and setRepoPairing in the app, take one lock on the rows of the repos involved (FOR UPDATE, in id order), so a pairing and a twin made at the same moment cannot both pass.
--      repo_twins_owner needs UPDATE on one column of repos for that lock (it updates nothing); the new policy pins it to the session's account.
--   3. twin_connect_seen: the repo sync calls it in its own transaction after it wrote repos. A not_connected twin whose private repo (by its GitHub id) the App now sees gets that repo
--      and the state seeding. A repo that cannot be connected (a pairing on it by id or by name, another live twin holding it, the twin's own public repo) leaves the twin where it is. Each connect writes one audit row (ids and states).

GRANT SELECT (gh_repo_id, gh_owner, gh_name, installation_id, product) ON repos TO repo_twins_owner;
GRANT UPDATE (updated_at) ON repos TO repo_twins_owner;
CREATE POLICY repo_twins_owner_lock ON repos FOR UPDATE TO repo_twins_owner
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
GRANT SELECT (code_repo) ON repo_pairing TO repo_twins_owner;
DROP POLICY repo_twins_owner_audit ON audit_log;
CREATE POLICY repo_twins_owner_audit ON audit_log FOR INSERT TO repo_twins_owner
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND action IN ('twin.created', 'twin.paused', 'twin.resumed', 'twin.removed', 'twin.connected'));

-- The migration role holds repo_twins_owner only to replace and hand over the functions (1097's shape).
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'repo_twins_owner'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on repo_twins_owner; cannot ALTER FUNCTION ... OWNER TO repo_twins_owner';
    END IF;
    GRANT repo_twins_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO repo_twins_owner;

CREATE OR REPLACE FUNCTION twin_record(p_public uuid, p_private uuid, p_gh_repo_id bigint, p_name text) RETURNS TABLE (o_result text, o_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v    public.repo_twins%ROWTYPE;
  v_state text := CASE WHEN p_private IS NULL THEN 'not_connected' ELSE 'seeding' END;
BEGIN
  IF acct IS NULL OR usr IS NULL OR NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = acct AND a.deleted_at IS NULL) OR NOT public.account_is_active(acct)
     OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'twin_record: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_public IS NULL OR p_name IS NULL OR p_private IS NOT DISTINCT FROM p_public THEN
    RAISE EXCEPTION 'twin_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.repos r WHERE r.account_id = acct AND r.id = p_public)
     OR (p_private IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.repos r WHERE r.account_id = acct AND r.id = p_private)) THEN
    RETURN QUERY SELECT 'not_found', NULL::uuid; RETURN;
  END IF;
  -- One lock on both repo rows, in id order (setRepoPairing takes the same lock in the same order). The checks below read after it, so each sees what the other side committed.
  PERFORM 1 FROM public.repos r WHERE r.account_id = acct AND r.id IN (p_public, p_private) ORDER BY r.id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.repo_pairing p WHERE p.account_id = acct AND p.repo_id IN (p_public, p_private))
     OR EXISTS (SELECT 1 FROM public.repo_pairing p JOIN public.repos r ON r.account_id = p.account_id AND r.id IN (p_public, p_private)
                 WHERE p.account_id = acct AND lower(p.code_repo) = lower(r.gh_owner || '/' || r.gh_name)) THEN
    RETURN QUERY SELECT 'pairing_exists', NULL::uuid; RETURN;
  END IF;
  -- A repo that is the other role of a live twin (this twin's own, removed row does not count).
  IF EXISTS (SELECT 1 FROM public.repo_twins t WHERE t.account_id = acct AND t.state <> 'removed' AND (t.private_repo_id = p_public OR t.public_repo_id = p_private)) THEN
    RETURN QUERY SELECT 'twin_exists', NULL::uuid; RETURN;
  END IF;
  SELECT * INTO v FROM public.repo_twins t WHERE t.account_id = acct AND t.public_repo_id = p_public FOR UPDATE;
  IF FOUND AND v.state <> 'removed' THEN
    RETURN QUERY SELECT 'twin_exists', NULL::uuid; RETURN;
  END IF;
  IF FOUND THEN
    UPDATE public.repo_twins SET private_repo_id = p_private, private_name = p_name, private_gh_repo_id = p_gh_repo_id, created_by = usr, state = v_state,
           overlay_globs = '{}', install_paths = '{}', binary_globs = '{}', identifier_rules_path = NULL, plan_data_rules_path = NULL, published_private_sha = NULL,
           synced_public_sha = NULL, publish_pr = NULL, sync_pr = NULL, failure_code = NULL, failure_reason = NULL, failure_at = NULL, removed_at = NULL, updated_at = now()
     WHERE id = v.id AND account_id = acct;
  ELSE
    INSERT INTO public.repo_twins (account_id, public_repo_id, private_repo_id, private_name, private_gh_repo_id, created_by, state)
    VALUES (acct, p_public, p_private, p_name, p_gh_repo_id, usr, v_state) RETURNING * INTO v;
  END IF;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'twin.created', jsonb_build_object('twin_id', v.id, 'public_repo_id', p_public, 'private_repo_id', p_private, 'state', v_state), clock_timestamp());
  RETURN QUERY SELECT 'ok', v.id;
EXCEPTION WHEN unique_violation THEN
  -- The private repo already belongs to another twin.
  RETURN QUERY SELECT 'twin_exists', NULL::uuid;
END;
$$;

-- The repo sync's step: returns how many twins of the session's account it connected. No person is needed (the sync has none); it moves only a not_connected twin to the repo row its own recorded GitHub id names.
CREATE FUNCTION twin_connect_seen() RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  t    record;
  n    integer := 0;
BEGIN
  IF acct IS NULL OR NOT public.account_is_active(acct) THEN
    RETURN 0;
  END IF;
  FOR t IN
    SELECT w.id, w.public_repo_id, r.id AS rid
      FROM public.repo_twins w
      JOIN public.repos r ON r.account_id = w.account_id AND r.gh_repo_id = w.private_gh_repo_id AND r.product = 'team' AND r.installation_id IS NOT NULL AND r.id <> w.public_repo_id
     WHERE w.account_id = acct AND w.state = 'not_connected' AND w.private_repo_id IS NULL
     ORDER BY w.id
  LOOP
    BEGIN
      PERFORM 1 FROM public.repos r WHERE r.account_id = acct AND r.id IN (t.public_repo_id, t.rid) ORDER BY r.id FOR UPDATE;
      IF EXISTS (SELECT 1 FROM public.repo_pairing p WHERE p.account_id = acct AND p.repo_id = t.rid)
         OR EXISTS (SELECT 1 FROM public.repo_pairing p JOIN public.repos r ON r.account_id = p.account_id AND r.id IN (t.public_repo_id, t.rid)
                     WHERE p.account_id = acct AND lower(p.code_repo) = lower(r.gh_owner || '/' || r.gh_name))
         OR EXISTS (SELECT 1 FROM public.repo_twins o WHERE o.account_id = acct AND o.state <> 'removed' AND o.id <> t.id AND (o.public_repo_id = t.rid OR o.private_repo_id = t.rid)) THEN
        CONTINUE;
      END IF;
      UPDATE public.repo_twins SET private_repo_id = t.rid, state = 'seeding', updated_at = now()
       WHERE id = t.id AND account_id = acct AND state = 'not_connected' AND private_repo_id IS NULL;
      IF FOUND THEN
        INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
        VALUES (acct, 'system', 'twin.connected', jsonb_build_object('twin_id', t.id, 'public_repo_id', t.public_repo_id, 'private_repo_id', t.rid, 'from', 'not_connected', 'to', 'seeding'), clock_timestamp());
        n := n + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Any error on one twin (another live twin took the repo between the check and the write, a constraint, a lock) leaves this one not_connected and the loop going.
      NULL;
    END;
  END LOOP;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION twin_connect_seen() FROM PUBLIC;
ALTER FUNCTION twin_connect_seen() OWNER TO repo_twins_owner;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner).
GRANT EXECUTE ON FUNCTION twin_connect_seen() TO app_user;

REVOKE CREATE ON SCHEMA public FROM repo_twins_owner;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE repo_twins_owner FROM CURRENT_USER;
  END IF;
END
$$;
