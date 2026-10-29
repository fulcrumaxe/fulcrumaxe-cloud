-- DP12b-2: the 15-minute per-account email window, derived from the database and never from process memory (Vercel invocations share none).
--   account_notify_window_open(account, seconds)  true when NO ask of the account has notified_at or renotified_at inside the last `seconds`.
-- A read only, owned by platform_ops like the 0930 definers, EXECUTE for receipt_writer_invoker only, nothing for PUBLIC, the platform_ops session
-- refused in the body. One extra policy lets the definer see the stamp of an ask that has already ended (answered, withdrawn, proceeded) for an hour
-- after it was stamped, so an ask that ends inside the window does not reopen it. The grants on the stamp columns are 0930's; nothing is added to them.
-- Expand-only: one function, one policy.

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

CREATE POLICY platform_ops_ask_notify_window_select ON decision_asks FOR SELECT TO platform_ops
  USING (session_user <> 'platform_ops'
         AND state NOT IN ('open', 'overdue')
         AND GREATEST(notified_at, renotified_at) > clock_timestamp() - interval '1 hour');

CREATE FUNCTION account_notify_window_open(p_account_id uuid, p_window_seconds integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'account_notify_window_open: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_window_seconds IS NULL OR p_window_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'account_notify_window_open: the window is 1 to 3600 seconds' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM public.decision_asks a
     WHERE a.account_id = p_account_id
       AND (a.notified_at > clock_timestamp() - make_interval(secs => p_window_seconds)
         OR a.renotified_at > clock_timestamp() - make_interval(secs => p_window_seconds)));
END $$;

REVOKE ALL ON FUNCTION account_notify_window_open(uuid, integer) FROM PUBLIC, CURRENT_USER;
GRANT EXECUTE ON FUNCTION account_notify_window_open(uuid, integer) TO receipt_writer_invoker;
ALTER FUNCTION account_notify_window_open(uuid, integer) OWNER TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
