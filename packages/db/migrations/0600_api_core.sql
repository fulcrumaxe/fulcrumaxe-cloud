-- D#31 API-1 (public API foundation): `idempotency_keys`.
--
-- Numbered 0600, not 0300, per the Team Lead's correction C9
-- (https://github.com/fulcrumaxe/cloud/discussions/31#discussioncomment-18500817):
-- "API-1's packages/db/migrations/0300_api_core.sql collides with D#5,
-- which has already reserved 0300_env.sql and 0301_env_secrets.sql (the
-- 03xx range) ... D#31 takes the 06xx range." Later D#31 migrations
-- (API-3b tokens, API-4 outbox/webhooks) continue at 0601, 0602, and so
-- on.
--
-- "The v1 contract" > Idempotency: the key is (account_id, key). The
-- table stores principal_id, method, path, request_sha256, status,
-- response, resource_id and expires_at (24h) -- see
-- packages/api/src/idempotency.ts for the read/write protocol built on
-- top of this table. RLS follows the exact tenant_isolation +
-- account_is_active(...) pattern every other tenant table in
-- 0001_core.sql uses (e.g. spend_reservations): a plain account_id
-- equality against the app.account_id session setting is what makes "the
-- same key used in account B runs fresh" (criterion 7's last bullet)
-- true, with no code in packages/api ever comparing account ids itself.
CREATE TABLE idempotency_keys (
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  key             text NOT NULL,
  principal_id    text NOT NULL,
  method          text NOT NULL,
  path            text NOT NULL,
  request_sha256  text NOT NULL,
  status          text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  response        jsonb,
  resource_id     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (account_id, key)
);

-- Lets a future sweep (API-4 criterion 12: "purges ... idempotency_keys
-- older than 24h") find expired rows without a full-table scan. The
-- composite primary key above already indexes (account_id, key), so no
-- separate account_id index is needed the way 0001_core.sql adds one for
-- every table whose primary key doesn't start with account_id.
CREATE INDEX idx_idempotency_keys_expires_at ON idempotency_keys (expires_at);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idempotency_keys TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
-- DELETE is granted (unlike spend_reservations/ledger/audit_log, which
-- deliberately withhold it -- see 0001_core.sql's security-fix-round-7/8
-- notes): a replay record carries no financial or audit history that
-- must outlive the request it dedupes, so packages/api/src/idempotency.ts
-- can free a key its own request failed to complete (`releaseIdempotencyKey`)
-- without leaving a dead `in_progress` row blocking a legitimate retry
-- until the 24h expiry sweep.
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO app_user;
