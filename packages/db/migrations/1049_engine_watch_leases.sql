-- D#845 ON-24b: who is watching a repo's engine, and the right of any member to ask for it.
--
-- engine_watch_leases: one row per (account, repo, user, browser) that holds a live view of an engine. It is the cloud's own record that somebody is looking, kept for three things:
-- the plan caps on concurrent watchers (counted per repo and per account), the end of a view (a hard maximum and an idle limit, both stamped when the lease starts from the plan the
-- account has at that moment), and the row a closed stream removes at once. `expires_at` is the one clock the rest reads: the lease is live while it is in the future. Every writer
-- keeps it at or below the hard maximum and the idle limit, and a renewal only ever moves a row that is still live, so nothing here can bring an ended view back.
--   * the route takes and renews a lease under a per-account advisory lock, so two requests cannot both slip under a cap;
--   * the event stream's 60 s re-check renews it in the statement it already runs, and removes it when the stream closes;
--   * a killed tab frees its slot when the 90 s life runs out.
-- Row security is the tenant policy plus the person: a member reads the account's leases (the caps are counted from them) and writes only their own, or sweeps a row that has expired.
-- A runner session reads nothing here and writes nothing.
--
-- engine_commands takes one more insert policy: any member of the account may insert a `watch` command, in their own name. A watch changes only how much a runner uploads (never what the
-- engine does), so the owner-or-admin rule of 1029 does not apply to it; every other kind keeps that rule untouched. The route, not the policy, decides when one is due.
--
-- No SECURITY DEFINER function and no role is added. Nothing reads the table until the route is deployed.
-- Rollback (expand/contract): drop the policy and the table; nothing else depends on either.

CREATE TABLE engine_watch_leases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id         uuid NOT NULL,
  user_id         uuid NOT NULL,
  browser_id      uuid NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  -- started_at + the plan's session maximum, fixed when the lease starts.
  hard_expires_at timestamptz NOT NULL,
  -- The last time the person did something on the view; the lease ends `idle_limit_s` after it.
  last_input_at   timestamptz NOT NULL DEFAULT now(),
  idle_limit_s    integer NOT NULL,
  -- min(last renewal + 90 s, hard_expires_at, last_input_at + idle_limit_s)
  expires_at      timestamptz NOT NULL,
  CONSTRAINT engine_watch_leases_key UNIQUE (account_id, repo_id, user_id, browser_id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, user_id) REFERENCES account_members (account_id, user_id) ON DELETE CASCADE,
  CONSTRAINT engine_watch_leases_limits CHECK (
    idle_limit_s BETWEEN 1 AND 86400
    AND hard_expires_at > started_at AND hard_expires_at <= started_at + interval '24 hours'
    AND expires_at <= hard_expires_at
  )
);
-- The caps count a repo's live rows and an account's live rows.
CREATE INDEX engine_watch_leases_repo_idx ON engine_watch_leases (account_id, repo_id, expires_at);

ALTER TABLE engine_watch_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE engine_watch_leases FORCE ROW LEVEL SECURITY;

REVOKE ALL ON engine_watch_leases FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON engine_watch_leases TO app_user;
-- Only the two columns a renewal moves: the start, the hard maximum and the idle limit are fixed when the lease is taken and no session can move them afterwards.
GRANT UPDATE (last_input_at, expires_at) ON engine_watch_leases TO app_user;

CREATE POLICY tenant_select ON engine_watch_leases FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND NULLIF(current_setting('app.runner_id', true), '') IS NULL
  );

CREATE POLICY own_insert ON engine_watch_leases FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND NULLIF(current_setting('app.runner_id', true), '') IS NULL
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = engine_watch_leases.account_id AND m.user_id = engine_watch_leases.user_id)
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

CREATE POLICY own_update ON engine_watch_leases FOR UPDATE TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND NULLIF(current_setting('app.runner_id', true), '') IS NULL
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = engine_watch_leases.account_id AND m.user_id = engine_watch_leases.user_id)
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = engine_watch_leases.account_id AND m.user_id = engine_watch_leases.user_id)
  );

-- A person removes their own lease; any member's expired row may be swept by whoever is taking a slot.
CREATE POLICY own_or_expired_delete ON engine_watch_leases FOR DELETE TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND NULLIF(current_setting('app.runner_id', true), '') IS NULL
    AND ((user_id = NULLIF(current_setting('app.user_id', true), '')::uuid AND EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = engine_watch_leases.account_id AND m.user_id = engine_watch_leases.user_id)) OR expires_at <= now())
  );

-- Any member may issue a `watch` command, in their own name, never inside a runner session. The other kinds stay with owners and admins (1029's `owner_admin_insert`).
CREATE POLICY member_watch_insert ON engine_commands FOR INSERT TO app_user
  WITH CHECK (
    kind = 'watch'
    AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND NULLIF(current_setting('app.runner_id', true), '') IS NULL
    AND issued_by = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND state = 'pending' AND refusal IS NULL AND delivered_at IS NULL AND acked_at IS NULL
    AND EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = engine_commands.account_id AND m.user_id = engine_commands.issued_by)
  );
