-- 0693: the stored run prompt (run_events kind 'run.input') is hidden at the
-- database, not only by the application read layer.
--
-- Why: the security review of the retry work found that the retained start
-- prompt (size-capped, hashed, redacted at the source) was kept out of view
-- only because every application reader happened to filter it. At the database
-- two roles could still reach it: the partner role under an active support
-- grant, and any SECURITY DEFINER function owned by platform_ops (its row
-- policy let a definer read every kind of the caller's tenant, payload
-- included). "Platform only" was a convention; this makes it a guarantee.
--
-- What changes (ALTER POLICY keeps both names, so nothing that names them
-- breaks):
--   * partner_support_grant_read on run_events: support staff keep every kind
--     except 'run.input'.
--   * platform_ops_claim_release_probe on run_events: a positive list. The one
--     platform_ops-owned reader (agent_run_release_idempotency_key) needs only
--     'run.status_changed', so that is the only kind this policy now admits.
--     A future platform_ops definer gets nothing else by default.
--
-- What does NOT change: app_user's tenant_isolation policy. The retry
-- performer reads 'run.input' (the prompt, and the meta for a replay) under
-- it, inside the caller's own tenant. Column grants stay as they are; the
-- policies are the gate.

ALTER POLICY partner_support_grant_read ON run_events
  USING (
    has_active_support_grant(run_events.account_id)
    AND kind <> 'run.input'
  );

ALTER POLICY platform_ops_claim_release_probe ON run_events
  USING (
    session_user <> 'platform_ops'
    AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND kind = 'run.status_changed'
  );
