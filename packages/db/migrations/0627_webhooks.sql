-- D#31 API-4a: the outbox (`domain_events`), and the schema for outbound
-- webhooks (`webhook_endpoints`, `webhook_deliveries`). API-4b (SSRF,
-- signing, the dispatcher, the endpoint routes) builds on this schema
-- without altering it -- the same "later task adds its own migration
-- instead of editing an already-merged one" precedent API-3d/API-3e/
-- API-3f set for `0616_api_tokens.sql`.
--
-- Numbered 0627 per R1 (merge-monotonic, packages/db/migrations/README.md):
-- 0625/0626 are claimed by the still-open PRs #171/#172. origin/main's own
-- newest file is 0624. Re-checked against origin/main and every open PR's
-- migrations immediately before this PR was pushed -- 0627 was free.
--
-- ---------------------------------------------------------------------
-- domain_events: the transactional outbox. Producers (H13a's pr.opened
-- hook, H21's markBroken, packages/spend's reserveWith deny paths, and
-- later H09/H14/D#29) write it INSIDE the same transaction as the state
-- change it describes -- atomicity is a property of how callers use this
-- table (see emit.ts), not something the schema itself enforces.
--
-- "A private serial and a public id" (resolved disagreement 13): `seq` is
-- a plain bigserial, never returned to a client -- API-5 will seal it into
-- an opaque cursor. `id` is the "evt_"+uuid public identifier used in the
-- webhook envelope. Exposing `seq` directly would let a subscriber
-- estimate the platform's total event volume from the gaps in its own ids.
--
-- `fanned_out_at`: set by the sweep (packages/webhooks/src/sweep.ts) once
-- an event has become zero or more `webhook_deliveries` rows. NULL means
-- "not yet fanned out" -- the sweep's own claim column.
CREATE TABLE domain_events (
  seq            bigserial NOT NULL UNIQUE,
  id             text PRIMARY KEY DEFAULT ('evt_' || gen_random_uuid()::text),
  account_id     uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  type           text NOT NULL,
  -- Optional correlation id (a work_item/run/endpoint id). Never used for
  -- tenant scoping -- account_id does that on its own.
  subject_id     text,
  -- Ids, enums and platform-derived identifiers ONLY (resolved
  -- disagreement 8) -- enforced by callers, not by this column's type.
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  fanned_out_at  timestamptz
);

-- The purge (criterion 12) scans across every tenant, so a standalone
-- created_at index is needed alongside the account-scoped one.
CREATE INDEX idx_domain_events_created_at ON domain_events (created_at);
CREATE INDEX idx_domain_events_account_id ON domain_events (account_id, created_at);
-- The sweep's fan-out claim query (SKIP LOCKED over not-yet-fanned-out
-- rows) -- a partial index that stays small regardless of table size.
CREATE INDEX idx_domain_events_pending_fanout ON domain_events (seq) WHERE fanned_out_at IS NULL;

ALTER TABLE domain_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_events FORCE ROW LEVEL SECURITY;

-- Producers write as app_user, in the SAME transaction as their own state
-- change -- the standard tenant_isolation + account_is_active(...) gate
-- every other producer table already uses (0001_core.sql's work_items
-- policy), so this insert never fails for a reason its sibling write in
-- that same transaction wouldn't also fail for.
CREATE POLICY tenant_isolation_select ON domain_events
  FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

CREATE POLICY tenant_isolation_insert ON domain_events
  FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

-- platform_ops: H21's markBroken runs as platform_ops (withPlatformOps, no
-- app.account_id set), and the sweep needs unconditional access.
CREATE POLICY platform_ops_full_access ON domain_events TO platform_ops
  USING (true) WITH CHECK (true);

-- No UPDATE grant to app_user: an event is immutable once written. The
-- sweep's `fanned_out_at` write is a platform_ops-only concern.
GRANT SELECT, INSERT ON domain_events TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON domain_events TO platform_ops;
-- `seq bigserial` backs itself with a sequence (domain_events_seq_seq); a
-- table-level INSERT grant does not include USAGE on it, which nextval()
-- needs on every INSERT.
GRANT USAGE, SELECT ON SEQUENCE domain_events_seq_seq TO app_user, platform_ops;

-- ---------------------------------------------------------------------
-- webhook_endpoints: the subscription rows. API-4b's routes own creating,
-- editing and deleting these; this migration only creates the schema and
-- its RLS, so the sweep has something to fan events out against.
--
-- The envelope-encryption columns mirror `model_connections`'s own shape
-- exactly (key_ciphertext/key_nonce/wrapped_dek/kek_version), matching
-- correction C6's `seal()`/`open()` helper, which API-4b calls with its
-- own `FX_WEBHOOK_KEK_V1`. API-4a never seals or opens a secret itself --
-- ssrf.ts/connector.ts/sign.ts/secrets.ts are out of scope here.
CREATE TABLE webhook_endpoints (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  url                 text NOT NULL,
  -- The v1 catalogue this endpoint is subscribed to, validated against
  -- the real catalogue at the application layer (API-4b).
  event_types         text[] NOT NULL CHECK (cardinality(event_types) > 0),
  secret_ciphertext   bytea NOT NULL,
  secret_nonce        bytea NOT NULL,
  wrapped_dek         bytea NOT NULL,
  kek_version         integer NOT NULL,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  -- 'failing' (criterion 8). No CHECK on the vocabulary -- diagnostic
  -- only, same convention as api_tokens.revoked_reason.
  disabled_reason     text,
  created_by          uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhook_endpoints_account_id ON webhook_endpoints (account_id);
-- The sweep's fan-out lookup ("which active endpoints subscribe to this
-- event's type") -- a GIN index for the `type = ANY(event_types)` check.
CREATE INDEX idx_webhook_endpoints_event_types ON webhook_endpoints USING gin (event_types);
CREATE INDEX idx_webhook_endpoints_active ON webhook_endpoints (account_id) WHERE status = 'active';

ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;

-- The v1 contract: every webhook-endpoints route (including GET) is
-- owner/admin only -- unlike api_tokens, there's no "a member sees its
-- own" carve-out, since an endpoint is an account-wide subscription, not
-- owned by whoever created it. Same shape as api_tokens's SELECT policy
-- (0616_api_tokens.sql), minus the "or my own row" disjunct.
CREATE POLICY tenant_isolation_select ON webhook_endpoints
  FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND EXISTS (
      SELECT 1 FROM account_members m
      WHERE m.account_id = webhook_endpoints.account_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
        AND m.role IN ('owner', 'admin')
    )
  );

CREATE POLICY tenant_isolation_insert ON webhook_endpoints
  FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND EXISTS (
      SELECT 1 FROM account_members m
      WHERE m.account_id = webhook_endpoints.account_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
        AND m.role IN ('owner', 'admin')
    )
  );

CREATE POLICY tenant_isolation_update ON webhook_endpoints
  FOR UPDATE TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND EXISTS (
      SELECT 1 FROM account_members m
      WHERE m.account_id = webhook_endpoints.account_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
        AND m.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

CREATE POLICY tenant_isolation_delete ON webhook_endpoints
  FOR DELETE TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND EXISTS (
      SELECT 1 FROM account_members m
      WHERE m.account_id = webhook_endpoints.account_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
        AND m.role IN ('owner', 'admin')
    )
  );

-- platform_ops: the sweep's fan-out read and auto-disable write (criterion 8).
CREATE POLICY platform_ops_full_access ON webhook_endpoints TO platform_ops
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_endpoints TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_endpoints TO platform_ops;

-- ---------------------------------------------------------------------
-- webhook_deliveries: one row per (event, subscribed endpoint) at
-- fan-out time. `event_id` has NO foreign key to domain_events(id):
-- domain_events is purged after 7 days while a delivery's own retention
-- is 30 days, so a delivery must outlive the event row it came from.
-- `event_type` is denormalized at fan-out time for the same reason -- the
-- delivery log must still show what kind of event a delivery was after
-- its source event is gone.
--
-- No response-body column (criterion 6) -- only a status code and error class.
CREATE TABLE webhook_deliveries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  endpoint_id        uuid NOT NULL REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
  event_id           text NOT NULL,
  event_type         text NOT NULL,
  status             text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'claimed', 'succeeded', 'dead')),
  attempt_count      integer NOT NULL DEFAULT 0,
  next_attempt_at    timestamptz NOT NULL DEFAULT now(),
  claimed_at         timestamptz,
  last_attempted_at  timestamptz,
  last_status_code   integer,
  last_error_class   text,
  dead_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhook_deliveries_endpoint_id ON webhook_deliveries (endpoint_id);
CREATE INDEX idx_webhook_deliveries_account_id ON webhook_deliveries (account_id);
-- The purge (criterion 12: "deliveries older than 30 d").
CREATE INDEX idx_webhook_deliveries_created_at ON webhook_deliveries (created_at);
-- "A partial index on pending rows": the claim query's own WHERE.
CREATE INDEX idx_webhook_deliveries_pending ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;

-- Read-only from the app side (the delivery log) -- every write (claim,
-- mark succeeded/dead, redeliver-reset) is a platform_ops/sweep concern.
CREATE POLICY tenant_isolation_select ON webhook_deliveries
  FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND EXISTS (
      SELECT 1 FROM account_members m
      WHERE m.account_id = webhook_deliveries.account_id
        AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
        AND m.role IN ('owner', 'admin')
    )
  );

CREATE POLICY platform_ops_full_access ON webhook_deliveries TO platform_ops
  USING (true) WITH CHECK (true);

GRANT SELECT ON webhook_deliveries TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_deliveries TO platform_ops;

-- ---------------------------------------------------------------------
-- Sweep purge access on two tables this migration doesn't own.
--
-- idempotency_keys (0600_api_core.sql) had NO platform_ops policy or
-- grant -- FORCE ROW LEVEL SECURITY means zero rows without one. That
-- file's header anticipated this ("Lets a future sweep ... find expired
-- rows"). This is that sweep.
CREATE POLICY platform_ops_full_access ON idempotency_keys TO platform_ops
  USING (true) WITH CHECK (true);
GRANT SELECT, DELETE ON idempotency_keys TO platform_ops;

-- rate_limit_windows (0622_rate_limits.sql) already has a
-- platform_ops_full_access policy but deliberately withheld the DELETE
-- grant ("API-4's future sweep grants that itself"). This is that grant.
GRANT DELETE ON rate_limit_windows TO platform_ops;

-- No new audit_log GRANT needed: 0200_partners.sql already gave
-- platform_ops its own INSERT policy + grant (for partner_suspend_
-- account's writer), which covers criterion 8's platform-initiated audit
-- write (no app.account_id/app.user_id is set, so the general
-- audit_write() definer, which requires a verified member, doesn't apply).
--
-- A function IS still needed: packages/db/test/audit-log-guard.test.ts
-- (D#76/D#97) statically forbids a raw `audit_log` reference under
-- packages/*/src/**, which migration SQL doesn't run through -- every
-- audit write in this schema goes through a function defined here instead.
CREATE FUNCTION audit_write_webhook_endpoint_disabled(p_account_id uuid, p_endpoint_id uuid)
RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO audit_log (account_id, actor, action, payload, created_at)
  VALUES (
    p_account_id,
    'platform_ops',
    'webhook_endpoint.disabled',
    jsonb_build_object('endpoint_id', p_endpoint_id, 'reason', 'failing'),
    clock_timestamp()
  );
$$;
-- Not SECURITY DEFINER: the only caller (packages/webhooks/src/sweep.ts)
-- already runs as platform_ops, which already holds its own INSERT grant
-- + policy on audit_log -- no privilege elevation needed, only a
-- non-TypeScript home for the raw INSERT.
REVOKE ALL ON FUNCTION audit_write_webhook_endpoint_disabled(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_write_webhook_endpoint_disabled(uuid, uuid) TO platform_ops;
