-- D#694 B6-5: the read path for a person's merge-queue presses (Remove from queue, its no-op answer, Queue again). Those presses are audit rows written by
-- audit_write_work_item_action (0713) as `work_item.sent_back` with the press in `payload.action`, and the audit row IS the recorded intent. Production code may
-- not read the audit table directly (D#76 criterion 10, D#97), so this one narrow definer reads them.
--
-- work_item_queue_intents(p_work_item_id, p_head_sha, p_window_minutes):
--   - the account comes from the tenant session (app.account_id), never from a parameter; no session account, or an account that is not active, is 42501
--   - only `work_item.sent_back` rows whose payload.action is queue_remove, queue_remove_noop or queue_again, for that item and that head
--   - p_window_minutes NULL is every such row; otherwise only rows newer than the database clock minus that many minutes (1 to 1440, else 22023)
--   - returns the row id, the press, when it was recorded, the head and pull request number it named, and (a no-op only) the id of the Remove row it
--     answers (`payload.answers`); never the actor or the rest of the payload
-- EXECUTE for app_user only: the webhook, the reconcile and the merge gate all read on the tenant session as app_user (the run writer login is a member).
--
-- The function belongs to a role of its own, queue_intent_reader, in 0900's shape: NOLOGIN, no members (the migration role holds it only inside this
-- file), column SELECT on exactly what the body reads, row policies for this role only, a pinned search_path. The row policy on audit_log is the same
-- rule as the body (the session's account, the three presses), so the role can read nothing else whatever a body says. platform_ops gains nothing.
--
-- Expand-only: a role, one function, grants and two row policies. No table, column or existing function changes. Numbered above the highest migration
-- on the code plane (0940) and the one held by an open change (0941). Re-check against main's highest right before merging; migrations merge in number order.
DO $$
DECLARE
  n text := 'queue_intent_reader';
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

GRANT USAGE ON SCHEMA public TO queue_intent_reader;
-- account_is_active() is a SECURITY INVOKER function, so the role must be able to read the one account in context.
GRANT SELECT (id, deleted_at) ON accounts TO queue_intent_reader;
GRANT SELECT (id, account_id, action, payload, created_at) ON audit_log TO queue_intent_reader;

CREATE POLICY queue_intent_reader_select ON accounts FOR SELECT TO queue_intent_reader
  USING (id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY queue_intent_reader_select ON audit_log FOR SELECT TO queue_intent_reader
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND action = 'work_item.sent_back' AND payload->>'action' IN ('queue_remove', 'queue_remove_noop', 'queue_again'));

-- Ownership bracket (0900's shape): the migrator needs SET on the role for ALTER ... OWNER TO, and the role has CREATE on public only for that transfer.
-- Both are reset at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'queue_intent_reader'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on queue_intent_reader; cannot ALTER FUNCTION ... OWNER TO queue_intent_reader';
    END IF;
    GRANT queue_intent_reader TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO queue_intent_reader;

CREATE FUNCTION work_item_queue_intents(p_work_item_id uuid, p_head_sha text, p_window_minutes integer)
RETURNS TABLE (id uuid, action text, created_at timestamptz, head_sha text, pr_number integer, answers uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
BEGIN
  IF acct IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'work_item_queue_intents: no active app.account_id set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_window_minutes IS NOT NULL AND (p_window_minutes < 1 OR p_window_minutes > 1440) THEN
    RAISE EXCEPTION 'work_item_queue_intents: window must be 1 to 1440 minutes' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
    SELECT a.id, a.payload->>'action', a.created_at, a.payload->>'head_sha',
           CASE WHEN a.payload->>'pr_number' ~ '^[0-9]{1,9}$' THEN (a.payload->>'pr_number')::integer END,
           CASE WHEN a.payload->>'action' = 'queue_remove_noop' AND a.payload->>'answers' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (a.payload->>'answers')::uuid END
      FROM public.audit_log a
     WHERE a.account_id = acct
       AND a.action = 'work_item.sent_back'
       AND a.payload->>'action' IN ('queue_remove', 'queue_remove_noop', 'queue_again')
       AND a.payload->>'work_item_id' = p_work_item_id::text
       AND a.payload->>'head_sha' = p_head_sha
       AND (p_window_minutes IS NULL OR a.created_at > clock_timestamp() - make_interval(mins => p_window_minutes))
     ORDER BY a.created_at, a.id;
END;
$$;

REVOKE ALL ON FUNCTION work_item_queue_intents(uuid, text, integer) FROM PUBLIC;
ALTER FUNCTION work_item_queue_intents(uuid, text, integer) OWNER TO queue_intent_reader;
GRANT EXECUTE ON FUNCTION work_item_queue_intents(uuid, text, integer) TO app_user;
REVOKE CREATE ON SCHEMA public FROM queue_intent_reader;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE queue_intent_reader FROM CURRENT_USER;
  END IF;
END
$$;
