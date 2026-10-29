-- DP12b-1: the database side of ask notification, and nothing else (no sending here). Four definers, all owned by platform_ops (the 0860 and
-- 0927 precedent), EXECUTE for receipt_writer_invoker only (the worker's cross-tenant login for the ask sweep), nothing for PUBLIC:
--   ask_notify_due(limit)            asks that need a first email (open, notified_at NULL) or the one reminder (overdue, renotified_at NULL),
--                                    across tenants. Ids, the kind and the timeout outcome enum only: no question or option text.
--   ask_stamp_notified(ask_id)       compare-and-set of notified_at: true only for the caller that changed it from NULL.
--   ask_stamp_renotified(ask_id)     the same for renotified_at, for an overdue ask.
--   account_notify_recipients(acct)  the distinct emails of the owners and admins of ONE active account that has a pending ask. Never a member.
-- Each definer refuses a platform_ops login. What platform_ops is given for this, and nothing else: SELECT and UPDATE on the two stamp columns
-- of decision_asks (SELECT also on timeout_outcome), and two policies that apply only to a session that is not a platform_ops login and only to
-- open or overdue asks. users and account_members already carry platform_ops_full_access (0001), accounts too, so the recipient lookup needs
-- nothing new. The immutability trigger (0666) still blocks every other column.
-- Expand-only: new functions, two policies, column grants.

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

GRANT SELECT (notified_at, renotified_at, timeout_outcome) ON decision_asks TO platform_ops;
GRANT UPDATE (notified_at, renotified_at) ON decision_asks TO platform_ops;
CREATE POLICY platform_ops_ask_notify_select ON decision_asks FOR SELECT TO platform_ops
  USING (session_user <> 'platform_ops' AND state IN ('open', 'overdue'));
CREATE POLICY platform_ops_ask_notify_update ON decision_asks FOR UPDATE TO platform_ops
  USING (session_user <> 'platform_ops' AND state IN ('open', 'overdue'))
  WITH CHECK (session_user <> 'platform_ops' AND state IN ('open', 'overdue'));

CREATE FUNCTION ask_notify_due(p_limit integer)
RETURNS TABLE (o_ask_id uuid, o_account_id uuid, o_kind text, o_timeout_outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'ask_notify_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'ask_notify_due: the limit is 1 to 500' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT a.id, a.account_id,
         CASE WHEN a.state = 'open' THEN 'first' ELSE 'reminder' END,
         a.timeout_outcome
    FROM public.decision_asks a
   WHERE ((a.state = 'open' AND a.notified_at IS NULL) OR (a.state = 'overdue' AND a.renotified_at IS NULL))
     AND (SELECT public.account_is_active(a.account_id))
   ORDER BY a.answer_due_at, a.id
   LIMIT p_limit;
END $$;

CREATE FUNCTION ask_stamp_notified(p_ask_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'ask_stamp_notified: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.decision_asks SET notified_at = clock_timestamp()
   WHERE id = p_ask_id AND notified_at IS NULL AND state IN ('open', 'overdue');
  RETURN FOUND;
END $$;

CREATE FUNCTION ask_stamp_renotified(p_ask_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'ask_stamp_renotified: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.decision_asks SET renotified_at = clock_timestamp()
   WHERE id = p_ask_id AND renotified_at IS NULL AND state = 'overdue';
  RETURN FOUND;
END $$;

CREATE FUNCTION account_notify_recipients(p_account_id uuid)
RETURNS TABLE (o_email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'account_notify_recipients: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT DISTINCT u.email
    FROM public.account_members m
    JOIN public.users u ON u.id = m.user_id
   WHERE m.account_id = p_account_id
     AND m.role IN ('owner', 'admin')
     AND (SELECT public.account_is_active(p_account_id))
     AND EXISTS (SELECT 1 FROM public.decision_asks a WHERE a.account_id = p_account_id AND a.state IN ('open', 'overdue'))
   ORDER BY u.email;
END $$;

REVOKE ALL ON FUNCTION ask_notify_due(integer) FROM PUBLIC, CURRENT_USER;
REVOKE ALL ON FUNCTION ask_stamp_notified(uuid) FROM PUBLIC, CURRENT_USER;
REVOKE ALL ON FUNCTION ask_stamp_renotified(uuid) FROM PUBLIC, CURRENT_USER;
REVOKE ALL ON FUNCTION account_notify_recipients(uuid) FROM PUBLIC, CURRENT_USER;
GRANT EXECUTE ON FUNCTION ask_notify_due(integer) TO receipt_writer_invoker;
GRANT EXECUTE ON FUNCTION ask_stamp_notified(uuid) TO receipt_writer_invoker;
GRANT EXECUTE ON FUNCTION ask_stamp_renotified(uuid) TO receipt_writer_invoker;
GRANT EXECUTE ON FUNCTION account_notify_recipients(uuid) TO receipt_writer_invoker;
ALTER FUNCTION ask_notify_due(integer) OWNER TO platform_ops;
ALTER FUNCTION ask_stamp_notified(uuid) OWNER TO platform_ops;
ALTER FUNCTION ask_stamp_renotified(uuid) OWNER TO platform_ops;
ALTER FUNCTION account_notify_recipients(uuid) OWNER TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
