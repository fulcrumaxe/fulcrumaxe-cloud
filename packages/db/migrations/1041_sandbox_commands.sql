-- D#587 B-7b: signed sandbox commands. An owner or admin asks one runner to stop a sandbox, delete a sandbox, or reap its stopped ones. The row is the queue and the
-- record of that request: the claim route signs it for the runner, hands it over on the claim reply, and the runner acks it on its next claim.
--
-- What:
--   sandbox_commands: one row per command. `kind` is a closed set, `name` follows the VM helper's id pattern and is present for stop and delete and absent for reap
--   (CHECKed here as well as by the route). `nonce` is unique: it is signed into the command and is the runner's single-use key. A command lives 600 seconds at most.
--   The state is a stamp the two writers move along one path only (the trigger): pending -> delivered -> applied | refused, or pending -> expired | cancelled.
--   A delivered row that is never acked stays `delivered`; the screens read it as unanswered once its life is over. Nothing here is a cron.
--
-- Who writes (RLS, FORCEd; app_user only, no DELETE grant, so the table is also the audit trail of who asked for what and when):
--   * a signed-in owner or admin, in their own name, inserts a pending row, may cancel one that is still pending, and may mark a pending one whose life is over
--     `expired` (asking again for a request nobody claimed in time must find the one-pending slot free);
--   * a verified runner session (app.runner_id, set only by the runner middleware) moves ITS OWN rows: pending -> delivered (claim), then one ack.
--     It can change four columns and nothing else, and it reads only its own rows.
--   Members and anything else read the account's rows and write nothing.
--
-- No SECURITY DEFINER function and no role is added. Nothing reads the table until the routes are deployed.
--
-- Numbered by the Team Lead. Re-check against main right before merging and renumber to stay above its highest.

CREATE TABLE sandbox_commands (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  runner_id    uuid NOT NULL,
  kind         text NOT NULL CONSTRAINT sandbox_commands_kind_check CHECK (kind IN ('stop_sandbox', 'delete_sandbox', 'reap_sandboxes')),
  name         text CONSTRAINT sandbox_commands_name_check CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  nonce        uuid NOT NULL DEFAULT gen_random_uuid() CONSTRAINT sandbox_commands_nonce_key UNIQUE,
  issued_by    uuid NOT NULL REFERENCES users (id),
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  state        text NOT NULL DEFAULT 'pending' CONSTRAINT sandbox_commands_state_check CHECK (state IN ('pending', 'delivered', 'applied', 'refused', 'expired', 'cancelled')),
  refusal      text CONSTRAINT sandbox_commands_refusal_check CHECK (refusal IN ('name_unknown', 'in_use', 'unsupported', 'failed')),
  delivered_at timestamptz,
  acked_at     timestamptz,
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE,
  CONSTRAINT sandbox_commands_name_with_kind CHECK ((kind = 'reap_sandboxes') = (name IS NULL)),
  CONSTRAINT sandbox_commands_life CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '600 seconds'),
  CONSTRAINT sandbox_commands_delivery CHECK (
    (state IN ('pending', 'cancelled', 'expired') AND delivered_at IS NULL AND acked_at IS NULL)
    OR (state = 'delivered' AND delivered_at IS NOT NULL AND acked_at IS NULL)
    OR (state IN ('applied', 'refused') AND delivered_at IS NOT NULL AND acked_at IS NOT NULL)
  ),
  CONSTRAINT sandbox_commands_refusal_state CHECK ((state = 'refused') = (refusal IS NOT NULL))
);
CREATE INDEX sandbox_commands_runner_pending_idx ON sandbox_commands (runner_id, issued_at, id) WHERE state = 'pending';
CREATE INDEX sandbox_commands_runner_issued_idx ON sandbox_commands (account_id, runner_id, issued_at DESC);
-- The same request twice while the first still waits is one request: a double click cannot queue two.
CREATE UNIQUE INDEX sandbox_commands_one_pending_idx ON sandbox_commands (runner_id, kind, COALESCE(name, '')) WHERE state = 'pending';

ALTER TABLE sandbox_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_commands FORCE ROW LEVEL SECURITY;

REVOKE ALL ON sandbox_commands FROM PUBLIC;
GRANT SELECT, INSERT ON sandbox_commands TO app_user;
GRANT UPDATE (state, delivered_at, acked_at, refusal) ON sandbox_commands TO app_user;

CREATE POLICY tenant_isolation_select ON sandbox_commands FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND (NULLIF(current_setting('app.runner_id', true), '') IS NULL OR runner_id::text = lower(current_setting('app.runner_id', true)))
  );

-- Issued by an owner or admin, in their own name, never inside a runner session, for a runner of the account that is not removed; starts pending.
CREATE POLICY owner_admin_insert ON sandbox_commands FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND NULLIF(current_setting('app.runner_id', true), '') IS NULL
    AND issued_by = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND state = 'pending' AND refusal IS NULL AND delivered_at IS NULL AND acked_at IS NULL
    AND EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = sandbox_commands.account_id AND m.user_id = sandbox_commands.issued_by AND m.role IN ('owner', 'admin'))
    AND EXISTS (SELECT 1 FROM runners r WHERE r.id = sandbox_commands.runner_id AND r.account_id = sandbox_commands.account_id AND r.revoked_at IS NULL)
  );

CREATE POLICY owner_admin_cancel ON sandbox_commands FOR UPDATE TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND NULLIF(current_setting('app.runner_id', true), '') IS NULL
    AND state = 'pending'
    AND EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = sandbox_commands.account_id AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid AND m.role IN ('owner', 'admin'))
  )
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND state IN ('cancelled', 'expired'));

-- Delivery and ack: the verified runner's own rows, while the runner is not removed.
CREATE POLICY runner_own_update ON sandbox_commands FOR UPDATE TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND runner_id::text = lower(COALESCE(current_setting('app.runner_id', true), ''))
    AND EXISTS (SELECT 1 FROM runners r WHERE r.id = sandbox_commands.runner_id AND r.account_id = sandbox_commands.account_id AND r.revoked_at IS NULL)
  )
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND runner_id::text = lower(COALESCE(current_setting('app.runner_id', true), '')));

-- The one path a row may take, and nothing else about it may change. Invoker rights. A connection with no tenant (the migration owner's) is not restricted here.
CREATE FUNCTION sandbox_commands_guard_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_runner boolean := NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL;
BEGIN
  IF NULLIF(current_setting('app.account_id', true), '') IS NULL THEN
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.account_id, NEW.runner_id, NEW.kind, NEW.name, NEW.nonce, NEW.issued_by, NEW.issued_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.id, OLD.account_id, OLD.runner_id, OLD.kind, OLD.name, OLD.nonce, OLD.issued_by, OLD.issued_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'sandbox_commands: a command is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT v_runner THEN
    IF OLD.state = 'pending' AND NEW.state = 'cancelled' AND OLD.expires_at > now() THEN RETURN NEW; END IF;
    -- A request nobody claimed in time is retired by the next person who asks for the same thing, so the pending slot is free again.
    IF OLD.state = 'pending' AND NEW.state = 'expired' AND OLD.expires_at <= now() AND NEW.delivered_at IS NULL AND NEW.acked_at IS NULL AND NEW.refusal IS NULL THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'sandbox_commands: not a transition a person can make' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.state = 'pending' AND NEW.state = 'delivered' AND OLD.expires_at > now() AND NEW.acked_at IS NULL AND NEW.refusal IS NULL THEN RETURN NEW; END IF;
  IF OLD.state = 'pending' AND NEW.state = 'expired' AND OLD.expires_at <= now() AND NEW.delivered_at IS NULL AND NEW.acked_at IS NULL AND NEW.refusal IS NULL THEN RETURN NEW; END IF;
  IF OLD.state = 'delivered' AND NEW.state IN ('applied', 'refused') AND NEW.delivered_at IS NOT DISTINCT FROM OLD.delivered_at AND NEW.acked_at IS NOT NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'sandbox_commands: not a transition a runner can make' USING ERRCODE = 'insufficient_privilege';
END;
$$;
REVOKE ALL ON FUNCTION sandbox_commands_guard_update() FROM PUBLIC;

CREATE TRIGGER sandbox_commands_guard_update
  BEFORE UPDATE ON sandbox_commands
  FOR EACH ROW EXECUTE FUNCTION sandbox_commands_guard_update();

-- ---- the capability: a hello that declares 'sandbox_commands_v1' must store ----------------------------------------------------------------------
-- The closed capability list and runner_capabilities_record widen by one value, from 1027's fifteen; everything else of the function is 1027's, verbatim.
ALTER TABLE runner_capabilities DROP CONSTRAINT runner_capabilities_values_check;
ALTER TABLE runner_capabilities ADD CONSTRAINT runner_capabilities_values_check
  CHECK (array_ndims(capabilities) IS NULL OR (array_ndims(capabilities) = 1 AND capabilities <@ ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1', 'browser_playwright_v1', 'overlap_facts_v1', 'engine_bridge_v1', 'sandbox_commands_v1']::text[]));

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'runner_capabilities_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_capabilities_definer; cannot replace runner_capabilities_record';
    END IF;
    EXECUTE 'GRANT runner_capabilities_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION runner_capabilities_record(p_capabilities text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  raw  text := COALESCE(current_setting('app.runner_id', true), '');
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_capabilities_record: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A live runner of an active account, named by the session: no runner in the session, a revoked one or another account's one writes nothing.
  IF acct IS NULL OR NOT account_is_active(acct) OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = raw::uuid AND r.account_id = acct AND r.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'runner_capabilities_record: the session is not a live runner of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Closed codes, each once, a flat list: anything else is refused, not repaired, so what is stored is exactly what was sent.
  IF p_capabilities IS NULL OR (cardinality(p_capabilities) > 0 AND array_ndims(p_capabilities) <> 1)
     OR EXISTS (SELECT 1 FROM unnest(p_capabilities) c WHERE c IS NULL OR c <> ALL (ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1', 'browser_playwright_v1', 'overlap_facts_v1', 'engine_bridge_v1', 'sandbox_commands_v1']))
     OR (SELECT count(*) <> count(DISTINCT c) FROM unnest(p_capabilities) c) THEN
    RAISE EXCEPTION 'runner_capabilities_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.runner_capabilities AS c (runner_id, account_id, capabilities)
  VALUES (raw::uuid, acct, p_capabilities)
  ON CONFLICT (runner_id) DO UPDATE SET capabilities = EXCLUDED.capabilities, reported_at = now();
END;
$$;
REVOKE ALL ON FUNCTION runner_capabilities_record(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_capabilities_record(text[]) TO app_user;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE 'REVOKE runner_capabilities_definer FROM CURRENT_USER';
  END IF;
END
$$;
