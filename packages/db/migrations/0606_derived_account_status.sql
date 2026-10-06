-- D#69 PR-A: accounts.status becomes a DERIVED column, computed by a
-- BEFORE trigger from a set of independent per-holder markers, instead of
-- a value application code writes directly. 0008 (D#76) is the base this
-- builds on.
--
-- WHY. Three separate parties can each want to stop an account running:
-- the owner (self-service pause), a reseller partner (suspend), and the
-- platform itself (a hold -- e.g. a Stripe dispute, per the "no refunds"
-- owner decision 18504974: PR-B's charge.dispute handler needs a hold
-- reason to set, not a refund). The old single `status` column could only
-- ever record ONE of these at a time, so the account's own billing state
-- (past_due) and a manual pause competed for the same column -- see
-- accountLifecycle.ts's pre-0606 history for the audit_log-based
-- workarounds this required. 0606 gives each holder its own timestamp
-- column; `status` is now derived from all of them by
-- accounts_derive_status() (a BEFORE trigger), and direct writes to
-- `status` are only accepted when they already equal the derived value --
-- a mismatched direct write is rejected outright (42501), for every role,
-- platform_ops included. Application code no longer sets `status`; it
-- sets the marker column for whichever holder it represents, and lets the
-- trigger compute the rest.
--
-- SIX-VALUE STATUS. `unsubscribed` (new decision 18504921 note: a brand
-- new signup, before any Stripe customer exists -- previously signups
-- incorrectly defaulted to 'active' with no paying customer behind them)
-- and `cancelled` (the 7-day past_due grace period, decision 18504921,
-- expires) join the original four. `cancelled` is the state PR-B's
-- 30-day retention purge acts on; nothing in PR-A purges a cancelled
-- account, it only reaches the state.
--
-- DERIVATION PRIORITY (highest wins -- see compute_account_status below):
--   1. platform_hold_at   -- platform enforcement (e.g. a dispute hold)
--   2. partner_suspended_at -- reseller enforcement
--   3. owner_paused_at    -- owner's own self-service pause
--   4. key_broken_at      -- H07's broken-model-connection state
--   5. past_due_since, within the 7-day grace window -- past_due
--   6. past_due_since, grace expired (> 7 days)       -- cancelled
--   7. stripe_customer_id IS NULL -- never checked out
--   8. otherwise -- active
-- Security review fix round 2 (D#69 PR-A, MUST-fix 1, CWE-841/863):
-- owner_paused_at and key_broken_at now outrank past_due_since. Under the
-- fix-round-1 order above, past_due_since always outranked a manual pause
-- or a broken key -- harmless while past_due was never itself runnable,
-- but this round makes a `past_due` account runnable for a 7-day grace
-- window (reserve.ts's own `withinGracePeriod` check), so the old order
-- let a signed `invoice.payment_failed` silently re-enable an account the
-- owner had paused, or one whose model key was broken, for up to 7 days.
-- `applyInvoicePaymentFailed` (accountLifecycle.ts) does not clear
-- owner_paused_at -- it only ever sets/COALESCEs its own past_due_since
-- marker -- so it is this priority order, not a clearing side-effect,
-- that keeps a pause (or a broken key) in force through a payment
-- failure. A pause is legal from `past_due` too now (accountStatus.ts's
-- `nextAccountStatus`): the owner can always stop runs by pausing,
-- whether or not the account happens to also be past_due underneath.
-- key_broken_at still ranks below every pause marker, so
-- markBroken/validate.ts's writes to it never lift a billing pause or a
-- manual pause -- they used to need an explicit `WHERE status = 'active'`
-- guard for exactly this; the priority order gives them that for free.
--
-- FAIL-CLOSED BACKFILL. See the DO block below: an existing 'active' row
-- with no stripe_customer_id would derive to 'unsubscribed' under the new
-- rule -- ambiguous data this migration refuses to guess at silently. It
-- raises and stops instead (test/migrate-0606-upgrade.test.ts covers
-- this).

-- ---------------------------------------------------------------------
-- 1. New columns.
-- ---------------------------------------------------------------------
ALTER TABLE accounts
  ADD COLUMN past_due_since      timestamptz,
  ADD COLUMN owner_paused_at     timestamptz,
  ADD COLUMN partner_suspended_at timestamptz,
  ADD COLUMN platform_hold_at    timestamptz,
  ADD COLUMN platform_hold_reason text,
  ADD COLUMN key_broken_at       timestamptz;

-- ---------------------------------------------------------------------
-- 2. The six-value CHECK, and a new default for brand-new signups
--    (accounts_derive_status below re-derives this regardless of the
--    default -- see packages/core/src/auth/identity.ts, which no longer
--    passes a status literal at all). Moved ahead of the backfill below
--    (originally step 3, after the backfill): the past_due backfill's
--    fix round 2 correction (SHOULD-fix 6) can write `status = 'cancelled'`
--    directly for a legacy past_due row whose resolved grace window has
--    already expired, and 'cancelled' isn't a legal value under the old
--    four-value constraint -- this has to be in place first.
-- ---------------------------------------------------------------------
ALTER TABLE accounts DROP CONSTRAINT accounts_status_check;
ALTER TABLE accounts ALTER COLUMN status SET DEFAULT 'unsubscribed';
ALTER TABLE accounts ADD CONSTRAINT accounts_status_check
  CHECK (status IN ('unsubscribed', 'active', 'past_due', 'paused', 'model_key_broken', 'cancelled'));

-- ---------------------------------------------------------------------
-- 3. Fail-closed backfill. Every legacy status must map onto a marker
--    state that re-derives to the SAME status it already had -- if it
--    can't (the 'active'-with-no-customer case), stop rather than guess.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  ambiguous_count int;
BEGIN
  SELECT count(*) INTO ambiguous_count
  FROM accounts
  WHERE status = 'active' AND stripe_customer_id IS NULL AND deleted_at IS NULL;

  IF ambiguous_count > 0 THEN
    RAISE EXCEPTION
      'migration 0606: % account(s) have status=active with no stripe_customer_id; '
      'the new derivation would reclassify them as unsubscribed. Resolve manually '
      '(set stripe_customer_id, or an appropriate marker column) and re-run.',
      ambiguous_count;
  END IF;
END
$$;

-- Security review fix round 2 (SHOULD-fix, CWE-841-adjacent): backfilling
-- past_due_since to now() would hand every legacy past_due account a
-- brand-new 7-day runnable grace window at migration time, even one that
-- has genuinely been past_due for months. Prefer the timestamp of its
-- earliest recorded `invoice.payment_failed` webhook, still sitting in
-- the pre-cutover audit_log ledger this migration hasn't moved yet (see
-- step 10 below) -- that is the real first-failure time, same as
-- applyStatusEvent's own COALESCE keeps going forward. When no such
-- event is on record (data predates webhook logging, or the status was
-- set some other way), fall back to now() minus 7 days: since the grace
-- check is strictly `>`, that lands exactly on the boundary and grants no
-- grace at all, rather than silently granting a full week to a row this
-- migration has no evidence is actually still within one.
--
-- accounts_derive_status doesn't exist yet at this point in the file (it
-- and its trigger are created in step 5, below), so this UPDATE does NOT
-- get its `status` column re-derived for free the way every write does
-- once the trigger exists -- a resolved timestamp that lands outside the
-- 7-day window would otherwise leave a stale `status = 'past_due'`
-- literal sitting next to a past_due_since that actually derives to
-- 'cancelled', which is exactly the mismatch step 11's self-check exists
-- to catch. Resolve the timestamp once in a CTE and set both columns
-- from that SAME value, using the identical `>` boundary
-- compute_account_status uses, so the two can never disagree.
--
-- Security review fix round 3 (MUST-fix 1, CWE-345/CWE-841): the earliest
-- `invoice.payment_failed` row is evidence, not authority -- before 0008,
-- `app_user` could INSERT into `audit_log` with any `created_at` it chose
-- (0008's own header records two live exploits of exactly that), so an
-- account forged with a future-dated failure row would otherwise resolve
-- to a `past_due_since` in the future and stay `past_due` (runnable)
-- indefinitely: the CASE below only ever compares it against `now() -
-- interval '7 days'` on the low side, never against `now()` on the high
-- side. Cap the resolved value at this migration's own clock with LEAST()
-- so a forged row gets at most the same 7-day grace an honest,
-- just-failed account gets -- never more. The cap is applied once, here,
-- and both the stored `past_due_since` and the status CASE below read the
-- SAME capped value, for the identical reason the timestamp is resolved
-- once in this CTE at all: they can never disagree.
WITH legacy_past_due AS (
  SELECT id,
    LEAST(
      COALESCE(
        (SELECT MIN(al.created_at)
           FROM audit_log al
           WHERE al.account_id = accounts.id
             AND al.action = 'stripe_webhook_event'
             AND al.payload ->> 'stripeEventType' = 'invoice.payment_failed'),
        now() - interval '7 days'
      ),
      now()
    ) AS resolved_past_due_since
  FROM accounts
  WHERE status = 'past_due' AND past_due_since IS NULL
)
UPDATE accounts a
  SET past_due_since = l.resolved_past_due_since,
      status = CASE
        WHEN l.resolved_past_due_since > now() - interval '7 days' THEN 'past_due'
        ELSE 'cancelled'
      END
  FROM legacy_past_due l
  WHERE a.id = l.id;
-- Security review MUST-fix 1 (CWE-863): a legacy 'paused' row can be EITHER
-- an owner's self-service pause OR a partner's suspension -- 0200's
-- partner_suspend_account (pre-0606) wrote the very same plain 'paused'
-- value the owner-initiated path did, so nothing left in the row tells
-- them apart. Backfilling to owner_paused_at would let the owner's own
-- resumeAccount silently lift what may actually be a partner suspension
-- (or a platform hold). Fail closed instead: every legacy paused row
-- becomes a platform hold, which only platform_ops can release.
UPDATE accounts
  SET platform_hold_at = now(), platform_hold_reason = 'legacy_pause_backfill'
  WHERE status = 'paused' AND platform_hold_at IS NULL;
UPDATE accounts SET key_broken_at = now() WHERE status = 'model_key_broken' AND key_broken_at IS NULL;

-- ---------------------------------------------------------------------
-- 4. compute_account_status(): pure derivation, no table access -- lets
--    the truth-table test call it directly without touching Postgres
--    for every row.
-- ---------------------------------------------------------------------
CREATE FUNCTION compute_account_status(
  p_stripe_customer_id   text,
  p_past_due_since       timestamptz,
  p_owner_paused_at      timestamptz,
  p_partner_suspended_at timestamptz,
  p_platform_hold_at     timestamptz,
  p_key_broken_at        timestamptz
) RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN p_platform_hold_at IS NOT NULL THEN 'paused'
    WHEN p_partner_suspended_at IS NOT NULL THEN 'paused'
    WHEN p_owner_paused_at IS NOT NULL THEN 'paused'
    WHEN p_key_broken_at IS NOT NULL THEN 'model_key_broken'
    WHEN p_past_due_since IS NOT NULL AND p_past_due_since > now() - interval '7 days' THEN 'past_due'
    WHEN p_past_due_since IS NOT NULL THEN 'cancelled'
    WHEN p_stripe_customer_id IS NULL THEN 'unsubscribed'
    ELSE 'active'
  END;
$$;

-- ---------------------------------------------------------------------
-- 5. accounts_derive_status(): BEFORE INSERT OR UPDATE. Always overwrites
--    NEW.status with the derived value. It refuses outright (42501,
--    insufficient_privilege):
--      - on UPDATE, whenever the SET clause names `status` explicitly
--        with a value that does not match derivation -- an ordinary
--        marker-only UPDATE never touches `status` in its SET list, so
--        NEW.status = OLD.status coming in and this check never trips
--        for it;
--      - on INSERT, whenever the row's `status` (explicit or the column
--        DEFAULT 'unsubscribed') does not match derivation (security
--        review MUST-fix 4, Spec A5, CWE-754). Before this, `INSERT ...
--        (status, stripe_customer_id) VALUES ('paused', 'cus_E')`
--        silently landed on 'active' -- a caller meaning "create this
--        account paused" got a running account and no error. Every
--        INSERT that carries a stripe_customer_id or a marker column now
--        MUST also spell out the `status` those columns derive to
--        (`identity.ts` and this migration's own test seed helpers do);
--        an INSERT of `id` alone still lands on the default
--        'unsubscribed', which always matches derivation for a
--        brand-new, marker-free row.
-- ---------------------------------------------------------------------
CREATE FUNCTION accounts_derive_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  derived text;
BEGIN
  derived := compute_account_status(
    NEW.stripe_customer_id, NEW.past_due_since, NEW.owner_paused_at,
    NEW.partner_suspended_at, NEW.platform_hold_at, NEW.key_broken_at
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

CREATE TRIGGER accounts_derive_status
  BEFORE INSERT OR UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_derive_status();

-- ---------------------------------------------------------------------
-- 6. stripe_customer_id uniqueness, among live accounts, with a
--    duplicate pre-check (accountLifecycle.ts's own long-standing note:
--    "stripe_customer_id has no UNIQUE constraint -- adding one is a
--    migration" -- this is that migration). Partial on deleted_at IS
--    NULL: a soft-deleted account may keep a customer id another,
--    currently-live account has since claimed.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  dup_count int;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT stripe_customer_id FROM accounts
    WHERE deleted_at IS NULL AND stripe_customer_id IS NOT NULL
    GROUP BY stripe_customer_id HAVING count(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'migration 0606: % duplicate stripe_customer_id value(s) among live accounts; resolve before adding the unique index',
      dup_count;
  END IF;
END
$$;

CREATE UNIQUE INDEX accounts_stripe_customer_id_live_uniq
  ON accounts (stripe_customer_id) WHERE deleted_at IS NULL AND stripe_customer_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 7. stripe_webhook_events: the platform_ops-only dedupe ledger,
--    replacing packages/billing/src/idempotency.ts's abuse of audit_log
--    for the same purpose (D#76's own note on this file: "D#69 owns
--    moving that ledger to its own platform_ops-only table instead").
--    FORCE RLS, one unconditional platform_ops policy, no grant of any
--    kind to app_user or partner_user.
-- ---------------------------------------------------------------------
CREATE TABLE stripe_webhook_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id   text NOT NULL UNIQUE,
  stripe_event_type text NOT NULL,
  account_id        uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_stripe_webhook_events_account_id ON stripe_webhook_events (account_id);

ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_ops_full_access ON stripe_webhook_events TO platform_ops
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON stripe_webhook_events TO platform_ops;

-- ---------------------------------------------------------------------
-- 8. partner_suspend_account / partner_unsuspend_account: the former now
--    sets partner_suspended_at instead of writing `status` directly (the
--    direct write would now be rejected by accounts_derive_status unless
--    it happened to already match derivation). CREATE OR REPLACE keeps
--    the existing owner/EXECUTE grant from 0200_partners.sql.
--
--    Security review SHOULD-fix 3: CREATE OR REPLACE FUNCTION needs
--    inherited owner privileges on the existing function (owned by
--    platform_ops). On a Neon-shaped database (D#81, migrated with #92's
--    0001/0200), the migration role holds platform_ops only as `INHERIT
--    FALSE, SET TRUE`, so the bare REPLACE aborts with "must be owner of
--    function partner_suspend_account". Bracket just this one statement
--    with a temporary INHERIT TRUE grant, reverting it immediately after
--    -- skipped entirely for a superuser (a fresh from-scratch install),
--    which already owns everything and has no `platform_ops` role
--    membership to grant/revoke.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION partner_suspend_account(target_account_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  caller_partner_id uuid := NULLIF(current_setting('app.partner_id', true), '')::uuid;
  caller_user_id     uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  is_admin_member    boolean;
  owns               boolean;
BEGIN
  IF caller_partner_id IS NULL THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM partner_members
    WHERE partner_id = caller_partner_id
      AND user_id = caller_user_id
      AND role IN ('owner', 'admin')
  ) INTO is_admin_member;

  IF NOT is_admin_member THEN
    RAISE EXCEPTION 'partner_suspend_account: caller is not an owner/admin member of partner %', caller_partner_id;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM accounts WHERE id = target_account_id AND partner_id = caller_partner_id
  ) INTO owns;

  IF owns THEN
    -- Security review SHOULD-fix 7 (cheap): COALESCE keeps the original
    -- suspension timestamp on a repeat suspend, instead of a later call
    -- silently resetting how long the account has actually been
    -- suspended.
    UPDATE accounts SET partner_suspended_at = COALESCE(partner_suspended_at, now()), updated_at = now()
    WHERE id = target_account_id;
    INSERT INTO audit_log (account_id, actor, action, payload)
    VALUES (target_account_id, caller_user_id::text, 'partner_suspend',
            jsonb_build_object('partner_id', caller_partner_id));
    INSERT INTO partner_audit_log (partner_id, actor, action, payload)
    VALUES (caller_partner_id, caller_user_id::text, 'suspend_account',
            jsonb_build_object('account_id', target_account_id));
  ELSE
    INSERT INTO partner_audit_log (partner_id, actor, action, payload)
    VALUES (caller_partner_id, caller_user_id::text, 'suspend_account_refused',
            jsonb_build_object('account_id', target_account_id));
  END IF;
END;
$$;

-- Revert the temporary grant above immediately after the one statement
-- that needed it -- same superuser skip as the grant itself.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;

-- D#81 fix round (security review, per-file bracket rule --
-- docs/ops/hosted-postgres.md, #92): the two `ALTER FUNCTION ... OWNER TO
-- platform_ops` statements below (partner_unsuspend_account,
-- platform_set_pause_marker) need platform_ops to hold CREATE on schema
-- public at the moment each one runs. That is not guaranteed by
-- 0001_core.sql's original grant alone -- on an already-migrated
-- database, filename order is not applied order, and this file could be
-- delivered after a later-numbered file has already revoked it.
-- Self-bracketed the same way every other later migration must be: grant
-- here, both transfers below, revoke once done. Unconditional, matching
-- 0001_core.sql's own grant style -- the migration role can always
-- GRANT/REVOKE this regardless of superuser status (unlike the INHERIT
-- bracket around partner_suspend_account above, which IS skipped for a
-- superuser).
GRANT CREATE ON SCHEMA public TO platform_ops;

-- New: the unsuspend half. Same actor verification as suspend above --
-- an unauthorized caller changes nothing and writes no row, same reasoning
-- as suspend's own header comment in 0200_partners.sql.
CREATE FUNCTION partner_unsuspend_account(target_account_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  caller_partner_id uuid := NULLIF(current_setting('app.partner_id', true), '')::uuid;
  caller_user_id     uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  is_admin_member    boolean;
  owns               boolean;
BEGIN
  IF caller_partner_id IS NULL THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM partner_members
    WHERE partner_id = caller_partner_id
      AND user_id = caller_user_id
      AND role IN ('owner', 'admin')
  ) INTO is_admin_member;

  IF NOT is_admin_member THEN
    RAISE EXCEPTION 'partner_unsuspend_account: caller is not an owner/admin member of partner %', caller_partner_id;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM accounts WHERE id = target_account_id AND partner_id = caller_partner_id
  ) INTO owns;

  IF owns THEN
    UPDATE accounts SET partner_suspended_at = NULL, updated_at = now() WHERE id = target_account_id;
    INSERT INTO audit_log (account_id, actor, action, payload)
    VALUES (target_account_id, caller_user_id::text, 'partner_unsuspend',
            jsonb_build_object('partner_id', caller_partner_id));
    INSERT INTO partner_audit_log (partner_id, actor, action, payload)
    VALUES (caller_partner_id, caller_user_id::text, 'unsuspend_account',
            jsonb_build_object('account_id', target_account_id));
  ELSE
    INSERT INTO partner_audit_log (partner_id, actor, action, payload)
    VALUES (caller_partner_id, caller_user_id::text, 'unsuspend_account_refused',
            jsonb_build_object('account_id', target_account_id));
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION partner_unsuspend_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION partner_unsuspend_account(uuid) TO partner_user;
ALTER FUNCTION partner_unsuspend_account(uuid) OWNER TO platform_ops;

-- ---------------------------------------------------------------------
-- 9. platform_set_pause_marker: platform_ops's own hold/unhold action --
--    e.g. PR-B's charge.dispute handler (owner decision 18504974: no
--    refunds, but the platform-hold marker must support reason =
--    'dispute'). Routed through audit_write_system (D#76) rather than a
--    direct audit_log INSERT, since platform_set_pause_marker has no
--    existing SECURITY DEFINER precedent of its own to preserve (unlike
--    partner_suspend_account, which D#76 deliberately left un-migrated).
-- ---------------------------------------------------------------------
CREATE FUNCTION platform_set_pause_marker(
  p_account_id uuid,
  p_hold       boolean,
  p_reason     text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Security review informational finding (cheap SHOULD-fix, CWE-778):
  -- a hold must never land with an empty audit payload -- require a
  -- real reason whenever one is being SET. Clearing a hold still passes
  -- p_reason = NULL by design (nothing to explain), so this only guards
  -- the p_hold = true branch.
  --
  -- Security review fix round 2 (SHOULD-fix, CWE-20/778): btrim() strips
  -- only ASCII space, so a reason made up entirely of tabs, newlines, or
  -- other whitespace (e.g. E'\t', E'\n', E' \t\n ') slipped past the old
  -- `btrim(p_reason) = ''` check and set a hold with an effectively empty
  -- audit payload. `!~ '\S'` (no non-whitespace character anywhere in the
  -- string) rejects any reason that is empty or whitespace-only under
  -- Postgres's regex definition of \s, not just plain spaces.
  IF p_hold AND (p_reason IS NULL OR p_reason !~ '\S') THEN
    RAISE EXCEPTION 'platform_set_pause_marker: p_reason must be non-blank when setting a hold'
      USING ERRCODE = '22023';
  END IF;

  IF p_hold THEN
    UPDATE accounts SET platform_hold_at = now(), platform_hold_reason = p_reason, updated_at = now()
    WHERE id = p_account_id;
    PERFORM audit_write_system(p_account_id, 'platform_ops', 'account.platform_hold_set',
      jsonb_build_object('reason', p_reason));
  ELSE
    UPDATE accounts SET platform_hold_at = NULL, platform_hold_reason = NULL, updated_at = now()
    WHERE id = p_account_id;
    PERFORM audit_write_system(p_account_id, 'platform_ops', 'account.platform_hold_cleared', NULL);
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION platform_set_pause_marker(uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_set_pause_marker(uuid, boolean, text) TO platform_ops;
ALTER FUNCTION platform_set_pause_marker(uuid, boolean, text) OWNER TO platform_ops;

-- Close the window opened above -- right after this file's last OWNER TO
-- statement, matching 0200_partners.sql's own revoke placement (#92).
REVOKE CREATE ON SCHEMA public FROM platform_ops;

-- ---------------------------------------------------------------------
-- 10. Cutover dedupe: seed stripe_webhook_events from the legacy
--     audit_log ledger (packages/billing/src/idempotency.ts, now
--     archive/billing-idempotency-2026-09-18/), so a Stripe redelivery
--     of an event this app already processed before this migration ran
--     still dedupes against the new table instead of being re-applied.
--     DISTINCT ON + ON CONFLICT DO NOTHING: the old ledger had no UNIQUE
--     constraint on the event id, so a legacy duplicate (if any ever
--     slipped through) must not abort the migration -- keep the
--     earliest-recorded row for each event id and ignore the rest.
-- ---------------------------------------------------------------------
INSERT INTO stripe_webhook_events (stripe_event_id, stripe_event_type, account_id, created_at)
SELECT DISTINCT ON (payload ->> 'stripeEventId')
  payload ->> 'stripeEventId',
  payload ->> 'stripeEventType',
  account_id,
  created_at
FROM audit_log
WHERE action = 'stripe_webhook_event'
  AND payload ->> 'stripeEventId' IS NOT NULL
  AND payload ->> 'stripeEventType' IS NOT NULL
ORDER BY payload ->> 'stripeEventId', created_at ASC
ON CONFLICT (stripe_event_id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 11. Backfill self-check (security review MUST-fix 1's second half):
--     nothing above this point checked the backfill's own claim that
--     every row re-derives to the status it already had. Raise and stop
--     the migration rather than silently ship a row whose stored
--     `status` disagrees with what accounts_derive_status would compute
--     for it -- the same invariant Spec A5's own post-migration test
--     asserts, just enforced by the migration itself instead of trusted
--     to a follow-up test run.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  mismatched_count int;
BEGIN
  SELECT count(*) INTO mismatched_count
  FROM accounts
  WHERE status IS DISTINCT FROM compute_account_status(
    stripe_customer_id, past_due_since, owner_paused_at,
    partner_suspended_at, platform_hold_at, key_broken_at
  );

  IF mismatched_count > 0 THEN
    RAISE EXCEPTION
      'migration 0606: % account(s) have a stored status that does not match the derived value after backfill',
      mismatched_count;
  END IF;
END
$$;
