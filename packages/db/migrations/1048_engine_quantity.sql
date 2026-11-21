-- D#845 ON-22a: how many engines the account's subscription pays for, and whether it pays for a hosted plan.
--
--   accounts.engine_quantity integer NOT NULL DEFAULT 0, 0 to 1000: the summed quantity of the engine line item(s) on the account's one subscription, as the last fetched subscription said it.
--   Written by the billing sync (platform_ops) only, like every other stripe_* column: app_user has SELECT and no UPDATE on accounts, so a person cannot raise their own quantity. 0 is both "no engine item" and
--   "never synced", and readers treat it as no engines paid for (fail closed). Which engines are live is derived from placements on every read, never stored here.
--   The quantity survives the end of a subscription (it is the last one fetched), so a reader of it must also require that the account is paying: it is never read alone.
--
--   accounts.hosted_plan_paid boolean NOT NULL DEFAULT false: the last fetched subscription carries a recognised hosted-plan item (starter, team or scale). Written by the billing sync only,
--   from the fetched subscription's items on every apply; an engine-only subscription, one whose hosted item was removed, and a subscription with an unrecognised price all write false. `accounts.plan`
--   and the compute cap are kept as they were when a subscription stops carrying a hosted item (the plan is a record, not an entitlement), so every gate on hosted compute, hosted run limits or hosted
--   discounts requires this fact together with a paying standing. The default is false: a row nobody has synced has no hosted entitlement.
--   Backfill: until this migration every subscription was a hosted plan (the engine price did not exist), so an account that has one on file is marked.
--
--   accounts.engine_quantity_below_live_at timestamptz: set by the sync when the fetched quantity is below the engines live now (a portal edit, an ops change), cleared when it is not. The audit row
--   `engine_quantity_below_live` is written at the same time; this column is what a reader of the account (the Inbox notice, the coverage code) checks.
--
--   platform_ops reads project_placements to count live engines in the sync: a one-column SELECT (account_id) and a SELECT-only policy, so it can count rows and see nothing else.
--
-- Numbered 1048 by the Team Lead. Re-check against main right before merging and renumber to stay above its highest.

ALTER TABLE accounts
  ADD COLUMN engine_quantity integer NOT NULL DEFAULT 0 CONSTRAINT accounts_engine_quantity_check CHECK (engine_quantity BETWEEN 0 AND 1000),
  ADD COLUMN hosted_plan_paid boolean NOT NULL DEFAULT false,
  ADD COLUMN engine_quantity_below_live_at timestamptz;

-- The subscription column arrived with 0660; the upgrade-path tests apply this file to databases that stop short of it (and hold no accounts), so the backfill asks first.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'stripe_subscription_id') THEN
    EXECUTE 'UPDATE accounts SET hosted_plan_paid = true WHERE stripe_subscription_id IS NOT NULL';
  END IF;
END
$$;

-- project_placements arrived with 1035; the upgrade-path tests apply this file to databases that stop short of it, so the grant asks first.
DO $$
BEGIN
  IF to_regclass('public.project_placements') IS NOT NULL THEN
    GRANT SELECT (account_id) ON project_placements TO platform_ops;
    CREATE POLICY platform_ops_count ON project_placements FOR SELECT TO platform_ops USING (true);
  END IF;
END
$$;
