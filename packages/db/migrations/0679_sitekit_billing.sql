-- D#3 K09a: site-kit billing entitlements.
-- One row per site says whether its setup payment is paid and whether its
-- sync subscription is live. Only the signed Stripe webhook writes them
-- (platform_ops), the same pattern 0660 uses for `accounts`; app_user can
-- only read its own account's rows. Nothing here touches `accounts`, so a
-- site-kit customer id can never make an account "active" for the hosted
-- product (compute_account_status stays as it is).
--   - sitekit_checkout_sessions: insert-only record of each Checkout Session
--     our server created (session id -> account, site, product). The webhook
--     finds the site through this row, never through event metadata.
--   - sitekit_entitlements: the paid state, one row per site.
-- Both carry a composite FK (account_id, site_id) -> sites, so a row cannot
-- name another account's site.

CREATE TABLE sitekit_entitlements (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  site_id                   uuid NOT NULL UNIQUE,
  setup_paid_at             timestamptz,
  setup_payment_intent_id   text UNIQUE,
  sync_subscription_id      text UNIQUE,
  sync_status               text
    CONSTRAINT sitekit_entitlements_sync_status_check
    CHECK (sync_status IN (
      'incomplete', 'incomplete_expired', 'trialing', 'active',
      'past_due', 'canceled', 'unpaid', 'paused'
    )),
  sync_current_period_end   timestamptz,
  sync_cancel_at_period_end boolean NOT NULL DEFAULT false,
  sync_ended_at             timestamptz,
  stripe_synced_at          timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, site_id) REFERENCES sites (account_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_sitekit_entitlements_account_id ON sitekit_entitlements (account_id);

CREATE TABLE sitekit_checkout_sessions (
  session_id  text PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  site_id     uuid NOT NULL,
  product     text NOT NULL CHECK (product IN ('setup', 'sync')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, site_id) REFERENCES sites (account_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_sitekit_checkout_sessions_account_id ON sitekit_checkout_sessions (account_id);

ALTER TABLE sitekit_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE sitekit_entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON sitekit_entitlements FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY platform_ops_full_access ON sitekit_entitlements TO platform_ops
  USING (true) WITH CHECK (true);
GRANT SELECT ON sitekit_entitlements TO app_user;
GRANT SELECT, INSERT, UPDATE ON sitekit_entitlements TO platform_ops;

ALTER TABLE sitekit_checkout_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sitekit_checkout_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON sitekit_checkout_sessions FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY platform_ops_full_access ON sitekit_checkout_sessions TO platform_ops
  USING (true) WITH CHECK (true);
GRANT SELECT ON sitekit_checkout_sessions TO app_user;
GRANT SELECT, INSERT ON sitekit_checkout_sessions TO platform_ops;
