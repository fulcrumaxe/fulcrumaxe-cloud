-- D#69 PR-B1: the Stripe subscription columns on accounts, and a
-- `cancelled` state a fetched subscription can actually reach.
--
-- 0606 derives `cancelled` only from a past_due_since older than the
-- 7-day grace window, so a subscription Stripe reports as canceled had no
-- input that led there. `subscription_ended_at` is that input. The
-- webhook sync (a later PR) writes it; this migration only adds the
-- columns and the derivation.
--
-- DERIVATION PRIORITY (highest wins). Owner question 1, option A:
-- `cancelled` outranks every pause and broken-key marker.
--   1. subscription_ended_at set          -> cancelled
--   2. past_due_since older than 7 days   -> cancelled (grace expired)
--   3. platform_hold_at                   -> paused
--   4. partner_suspended_at               -> paused
--   5. owner_paused_at                    -> paused
--   6. key_broken_at                      -> model_key_broken
--   7. past_due_since within 7 days       -> past_due
--   8. stripe_customer_id IS NULL         -> unsubscribed
--   9. otherwise                          -> active
-- Rows 3-7 keep 0606's relative order, so a pause or a broken key still
-- outranks a payment failure that is inside its grace window. `cancelled`
-- is non-runnable, so ranking it first can never make an account runnable.
-- Option B (keep 0606's order) would move rows 1 and 2 below row 6; that is
-- the only change it needs.
--
-- The seventh argument defaults to NULL so 6-argument callers keep working.
-- The stored `status` of an existing row is not touched here: every new
-- column starts NULL, so no existing row re-derives differently, and a row
-- picks up the new order at its next write.

-- ---------------------------------------------------------------------
-- 1. Columns. No grant changes: app_user has SELECT only on accounts and
--    platform_ops has table-level UPDATE (0001), so the new columns are
--    platform_ops-writable and not app_user-writable already. partner_user
--    has a column-level SELECT list (0200) that these are not on.
-- ---------------------------------------------------------------------
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_status text
    CONSTRAINT accounts_stripe_subscription_status_check
    CHECK (stripe_subscription_status IN (
      'incomplete', 'incomplete_expired', 'trialing', 'active',
      'past_due', 'canceled', 'unpaid', 'paused'
    )),
  ADD COLUMN IF NOT EXISTS stripe_cancel_at_period_end boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_current_period_end timestamptz,
  ADD COLUMN IF NOT EXISTS stripe_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS subscription_ended_at timestamptz,
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS terms_policy_version text;

-- ---------------------------------------------------------------------
-- 2. The derivation, with subscription_ended_at as a seventh input.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS compute_account_status(text, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION compute_account_status(
  p_stripe_customer_id     text,
  p_past_due_since         timestamptz,
  p_owner_paused_at        timestamptz,
  p_partner_suspended_at   timestamptz,
  p_platform_hold_at       timestamptz,
  p_key_broken_at          timestamptz,
  p_subscription_ended_at  timestamptz DEFAULT NULL
) RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN p_subscription_ended_at IS NOT NULL
      OR (p_past_due_since IS NOT NULL AND NOT (p_past_due_since > now() - interval '7 days')) THEN 'cancelled'
    WHEN p_platform_hold_at IS NOT NULL THEN 'paused'
    WHEN p_partner_suspended_at IS NOT NULL THEN 'paused'
    WHEN p_owner_paused_at IS NOT NULL THEN 'paused'
    WHEN p_key_broken_at IS NOT NULL THEN 'model_key_broken'
    WHEN p_past_due_since IS NOT NULL THEN 'past_due'
    WHEN p_stripe_customer_id IS NULL THEN 'unsubscribed'
    ELSE 'active'
  END;
$$;

-- ---------------------------------------------------------------------
-- 3. The trigger function, unchanged except that it passes the new input.
--    The trigger itself (0606) already points at this function by name.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounts_derive_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  derived text;
BEGIN
  derived := compute_account_status(
    NEW.stripe_customer_id, NEW.past_due_since, NEW.owner_paused_at,
    NEW.partner_suspended_at, NEW.platform_hold_at, NEW.key_broken_at,
    NEW.subscription_ended_at
  );

  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status IS DISTINCT FROM derived THEN
    RAISE EXCEPTION 'accounts.status is derived and cannot be written directly (wrote %, derived %)', NEW.status, derived
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.status IS DISTINCT FROM derived THEN
    RAISE EXCEPTION 'accounts.status is derived and cannot be written directly (wrote %, derived %)', NEW.status, derived
      USING ERRCODE = '42501';
  END IF;

  NEW.status := derived;
  RETURN NEW;
END;
$$;
