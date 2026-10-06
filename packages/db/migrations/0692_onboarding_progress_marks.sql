-- D#2 H17d: two write-once onboarding marks on accounts, so the progress read has a durable "first time" for
-- the two steps that no existing column keeps:
--   * onboarding_key_ok_at  the first time any model connection of the account was 'ok';
--   * onboarding_paid_at    the first time the account's subscription was 'active' or 'trialing'.
-- model_connections.last_validated_at moves on every re-validation and the billing columns move on every sync, so
-- neither could answer "when did this first happen".
--
-- Who writes what. Nobody sets a mark by hand: a trigger on accounts holds both columns, for every role and for a
-- superuser. Once a mark is set it keeps its value. A mark can only go from NULL to now(), by two routes:
--   * paid: the same accounts write that makes stripe_subscription_status 'active' or 'trialing' (the guard sets it);
--   * key:  an AFTER trigger on model_connections calls a definer that names the account for the guard to accept.
-- The guard ignores any value a writer supplies. app_user keeps SELECT only on accounts (0001), so a direct app_user
-- UPDATE of a mark is 42501 as before; platform_ops has table-level UPDATE and is held by the guard, not by a grant.
-- The definer is owned by platform_ops and touches one column of one account. No new role, no grant to app_user.
-- Privilege brackets as in 0689.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

ALTER TABLE accounts
  ADD COLUMN onboarding_key_ok_at timestamptz NULL,
  ADD COLUMN onboarding_paid_at   timestamptz NULL;

-- BACKFILL from the best durable evidence there is, before the guard exists. It is approximate on purpose:
--   * key:  last_validated_at of a connection that is 'ok' now (the earliest such). An account whose key is broken
--           or gone now stays NULL, which is honest.
--   * paid: the earliest stripe_webhook_events row of a subscription-activating event type for the account, else
--           stripe_synced_at when the subscription is active or trialing now.
UPDATE accounts a SET onboarding_key_ok_at = s.t
  FROM (SELECT account_id, min(last_validated_at) AS t FROM model_connections
         WHERE status = 'ok' AND last_validated_at IS NOT NULL GROUP BY account_id) s
 WHERE a.id = s.account_id;

UPDATE accounts a SET onboarding_paid_at = COALESCE(
    (SELECT min(e.created_at) FROM stripe_webhook_events e
      WHERE e.account_id = a.id AND e.stripe_event_type IN ('checkout.session.completed', 'invoice.paid')),
    a.stripe_synced_at)
 WHERE (EXISTS (SELECT 1 FROM stripe_webhook_events e
                 WHERE e.account_id = a.id AND e.stripe_event_type IN ('checkout.session.completed', 'invoice.paid'))
        OR a.stripe_subscription_status IN ('active', 'trialing'));

-- The guard. A set mark keeps its value. An unset one becomes now() only on the two routes above.
CREATE FUNCTION accounts_onboarding_marks_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.onboarding_key_ok_at IS NOT NULL THEN
    NEW.onboarding_key_ok_at := OLD.onboarding_key_ok_at;
  ELSIF current_setting('fx.onboarding_key_ok_mark', true) = NEW.id::text THEN
    NEW.onboarding_key_ok_at := now();
  ELSE
    NEW.onboarding_key_ok_at := NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.onboarding_paid_at IS NOT NULL THEN
    NEW.onboarding_paid_at := OLD.onboarding_paid_at;
  ELSIF NEW.stripe_subscription_status IN ('active', 'trialing') THEN
    NEW.onboarding_paid_at := now();
  ELSE
    NEW.onboarding_paid_at := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounts_onboarding_marks_guard
  BEFORE INSERT OR UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_onboarding_marks_guard();

-- The key route. Runs in the writer's own transaction, as platform_ops, for the row's own account only.
CREATE FUNCTION model_connections_onboarding_mark() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM set_config('fx.onboarding_key_ok_mark', NEW.account_id::text, true);
  UPDATE public.accounts SET onboarding_key_ok_at = now() WHERE id = NEW.account_id AND onboarding_key_ok_at IS NULL;
  PERFORM set_config('fx.onboarding_key_ok_mark', '', true);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION model_connections_onboarding_mark() FROM PUBLIC;
ALTER FUNCTION model_connections_onboarding_mark() OWNER TO platform_ops;
CREATE TRIGGER model_connections_onboarding_mark
  AFTER INSERT OR UPDATE ON model_connections
  FOR EACH ROW WHEN (NEW.status = 'ok') EXECUTE FUNCTION model_connections_onboarding_mark();

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
