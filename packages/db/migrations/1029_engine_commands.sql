-- ENGINE-IN-CLOUD EB-8a: the command channel. A person (an owner or admin, on a session) issues one of seven closed commands to the engine running on
-- their own machine; the runner pulls it, checks it and acks the outcome.
--
-- What:
--   engine_commands: one row per command. `kind` and `args` are a closed set, checked here as well as by the route (engine_command_args_ok), so a
--   hand-written insert cannot hold anything else. `command_seq` is strictly increasing per (runner, repo) and unique. The state is a stamp the
--   two writers move along one path only (see the trigger): pending -> delivered -> applied | refused | not_confirmed | expired, or
--   pending -> expired | cancelled. A pending row past its `expires_at` is read as expired by the routes; nothing here is a cron.
--   The only prose a row can hold is `args.note` of an answer_ask, written by an owner or admin of the account; the audit trail never carries it.
--
-- Who writes (RLS, FORCEd; app_user only, no DELETE grant):
--   * a signed-in owner or admin, in their own name, inserts a pending row (and so cannot name another issuer or a runner session), and may
--     cancel one that is still pending;
--   * a verified runner session (app.runner_id, set only by the runner middleware) moves ITS OWN rows: pending -> delivered (pull), then one ack.
--     It can change four columns and nothing else, and it reads only its own rows.
--   Members and anything else read the account's rows and write nothing.
--
-- Halt (EB-11a, migration 1031) adds a BEFORE INSERT trigger here that refuses start-like commands while the repo is halted (HX409). Nothing in this
-- file reads a halt table, so this migration stands alone and merges before it. The insert runs as app_user, which 1031 grants engine_halt_lock to.
--
-- Rollback (expand/contract): nothing reads the table until the routes are deployed; a later migration may drop it.
--
-- Numbered 1029 by the Team Lead for the bridge milestone: it merges after 1026 to 1028. Re-check against main right before merging.

CREATE FUNCTION engine_command_args_ok(p_kind text, p_args jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  -- COALESCE: a missing key makes a comparison NULL, and a CHECK lets NULL through.
  SELECT COALESCE(jsonb_typeof(p_args) = 'object' AND CASE p_kind
    WHEN 'start_day' THEN p_args = '{}'::jsonb
    WHEN 'pause_loop' THEN p_args = '{}'::jsonb
    WHEN 'resume_loop' THEN p_args = '{}'::jsonb
    WHEN 'answer_ask' THEN
      NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_args) AS k WHERE k NOT IN ('ask_id', 'choice', 'note'))
      AND jsonb_typeof(p_args -> 'ask_id') = 'string' AND (p_args ->> 'ask_id') ~ '^[0-9a-f]{16}$'
      AND jsonb_typeof(p_args -> 'choice') = 'string' AND (p_args ->> 'choice') IN ('approve', 'decline', 'defer')
      AND (NOT p_args ? 'note' OR (jsonb_typeof(p_args -> 'note') = 'string' AND char_length(p_args ->> 'note') BETWEEN 1 AND 500
           AND (p_args ->> 'note') !~ '[\u0001-\u001f\u007f-\u009f؜‎‏ -‮⁦-⁩]'))
    WHEN 'set_dial' THEN
      NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_args) AS k WHERE k NOT IN ('dial_class', 'level', 'ttl'))
      AND jsonb_typeof(p_args -> 'dial_class') = 'string'
      AND (p_args ->> 'dial_class') IN ('docs.write', 'tests.add', 'deps.bump', 'agent.spawn', 'merge.standard', 'merge.fast-path', 'memory.write', 'archive.move')
      AND jsonb_typeof(p_args -> 'level') = 'number' AND (p_args ->> 'level') ~ '^[1-5]$'
      AND jsonb_typeof(p_args -> 'ttl') = 'string' AND (p_args ->> 'ttl') IN ('for_today', 'none')
    WHEN 'request_spawn' THEN
      NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_args) AS k WHERE k NOT IN ('role', 'discussion'))
      AND jsonb_typeof(p_args -> 'role') = 'string'
      AND (p_args ->> 'role') IN ('executor', 'code-reviewer', 'security-reviewer', 'acceptance-tester', 'browser-tester', 'project-manager',
                                  'technical-architect', 'product-owner', 'cost-analyst', 'performance-expert', 'security-expert')
      AND jsonb_typeof(p_args -> 'discussion') = 'number' AND (p_args ->> 'discussion') ~ '^[1-9][0-9]{0,9}$'
      AND (p_args ->> 'discussion')::bigint <= 2147483647
    WHEN 'stop_agent' THEN
      NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_args) AS k WHERE k <> 'agent_id')
      AND jsonb_typeof(p_args -> 'agent_id') = 'string' AND (p_args ->> 'agent_id') ~ '^[A-Za-z0-9_-]{1,64}$'
    ELSE false
  END, false);
$$;
REVOKE ALL ON FUNCTION engine_command_args_ok(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION engine_command_args_ok(text, jsonb) TO app_user;

CREATE TABLE engine_commands (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  runner_id           uuid NOT NULL,
  repo_id             uuid NOT NULL,
  command_seq         bigint NOT NULL CHECK (command_seq >= 1),
  kind                text NOT NULL CHECK (kind IN ('start_day', 'pause_loop', 'resume_loop', 'answer_ask', 'set_dial', 'request_spawn', 'stop_agent')),
  args                jsonb NOT NULL,
  issued_by           uuid NOT NULL REFERENCES users (id),
  issued_at           timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  state               text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'applied', 'refused', 'expired', 'cancelled', 'not_confirmed')),
  refusal             text CHECK (refusal IS NULL OR refusal IN ('signature_invalid', 'wrong_runner', 'wrong_repo', 'expired', 'seq_not_increasing', 'halted', 'operate_off',
                                                               'host_not_running', 'unknown_ask', 'unknown_agent', 'ceiling', 'already_answered')),
  delivered_at        timestamptz,
  acked_at            timestamptz,
  halt_epoch_at_issue integer NOT NULL DEFAULT 0 CHECK (halt_epoch_at_issue >= 0),
  UNIQUE (account_id, id),
  -- Strictly increasing per runner and repo, never reused: the runner keeps the last one it applied and refuses anything at or below it.
  CONSTRAINT engine_commands_seq_key UNIQUE (runner_id, repo_id, command_seq),
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  CONSTRAINT engine_commands_args_closed CHECK (engine_command_args_ok(kind, args)),
  -- Ten minutes at most, and the clock only runs forward (the signed command carries the same two stamps).
  CONSTRAINT engine_commands_life CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '600 seconds'),
  CONSTRAINT engine_commands_delivery CHECK (
    (state IN ('pending', 'cancelled') AND delivered_at IS NULL AND acked_at IS NULL)
    OR (state = 'delivered' AND delivered_at IS NOT NULL AND acked_at IS NULL)
    OR (state IN ('applied', 'refused', 'not_confirmed') AND delivered_at IS NOT NULL AND acked_at IS NOT NULL)
    OR state = 'expired'
  ),
  CONSTRAINT engine_commands_refusal_state CHECK (refusal IS NULL OR state IN ('refused', 'not_confirmed', 'expired')),
  CONSTRAINT engine_commands_refused_names_reason CHECK ((state = 'refused') = (refusal IS NOT NULL) OR state IN ('not_confirmed', 'expired'))
);
CREATE INDEX engine_commands_pull_idx ON engine_commands (runner_id, repo_id, command_seq) WHERE state = 'pending';
CREATE INDEX engine_commands_repo_issued_idx ON engine_commands (account_id, repo_id, issued_at DESC);

ALTER TABLE engine_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE engine_commands FORCE ROW LEVEL SECURITY;

REVOKE ALL ON engine_commands FROM PUBLIC;
GRANT SELECT, INSERT ON engine_commands TO app_user;
GRANT UPDATE (state, delivered_at, acked_at, refusal) ON engine_commands TO app_user;

-- Reads: the account's members see the account's rows; a runner session sees only its own runner's.
CREATE POLICY tenant_isolation_select ON engine_commands FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND (NULLIF(current_setting('app.runner_id', true), '') IS NULL OR runner_id::text = lower(current_setting('app.runner_id', true)))
  );

-- A command is issued by an owner or admin, in their own name, never inside a runner session (the decide route borrows the runner's registrant as
-- app.user_id for an audit write, so a runner transaction must not be able to issue as that person), and starts pending.
CREATE POLICY owner_admin_insert ON engine_commands FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND NULLIF(current_setting('app.runner_id', true), '') IS NULL
    AND issued_by = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND state = 'pending' AND refusal IS NULL AND delivered_at IS NULL AND acked_at IS NULL
    AND EXISTS (
      SELECT 1 FROM account_members m
      WHERE m.account_id = engine_commands.account_id AND m.user_id = engine_commands.issued_by AND m.role IN ('owner', 'admin')
    )
  );

-- Cancel: an owner or admin, a command still pending.
CREATE POLICY owner_admin_cancel ON engine_commands FOR UPDATE TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND NULLIF(current_setting('app.runner_id', true), '') IS NULL
    AND state = 'pending'
    AND EXISTS (
      SELECT 1 FROM account_members m
      WHERE m.account_id = engine_commands.account_id AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid AND m.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND state = 'cancelled');

-- Pull and ack: the verified runner's own rows, while the runner is not revoked.
CREATE POLICY runner_own_update ON engine_commands FOR UPDATE TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND runner_id::text = lower(COALESCE(current_setting('app.runner_id', true), ''))
    AND EXISTS (SELECT 1 FROM runners r WHERE r.id = engine_commands.runner_id AND r.account_id = engine_commands.account_id AND r.revoked_at IS NULL)
  )
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND runner_id::text = lower(COALESCE(current_setting('app.runner_id', true), '')));

-- The one path a row may take, and nothing else about it may change. Invoker rights. A connection with no tenant (the migration owner's) is not
-- restricted here: it is the only way to age a row in a test and it passes no policy either way.
CREATE FUNCTION engine_commands_guard_update()
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
  IF (NEW.id, NEW.account_id, NEW.runner_id, NEW.repo_id, NEW.command_seq, NEW.kind, NEW.args, NEW.issued_by, NEW.issued_at, NEW.expires_at, NEW.halt_epoch_at_issue)
     IS DISTINCT FROM (OLD.id, OLD.account_id, OLD.runner_id, OLD.repo_id, OLD.command_seq, OLD.kind, OLD.args, OLD.issued_by, OLD.issued_at, OLD.expires_at, OLD.halt_epoch_at_issue) THEN
    RAISE EXCEPTION 'engine_commands: a command is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT v_runner THEN
    -- A person can cancel one that is still pending and not yet past its life.
    IF OLD.state = 'pending' AND NEW.state = 'cancelled' AND OLD.expires_at > now() THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'engine_commands: not a transition a person can make' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.state = 'pending' AND NEW.state = 'delivered' AND OLD.expires_at > now() AND NEW.acked_at IS NULL AND NEW.refusal IS NULL THEN RETURN NEW; END IF;
  IF OLD.state = 'pending' AND NEW.state = 'expired' AND OLD.expires_at <= now() AND NEW.delivered_at IS NULL AND NEW.acked_at IS NULL AND NEW.refusal IS NULL THEN RETURN NEW; END IF;
  IF OLD.state = 'delivered' AND NEW.state IN ('applied', 'refused', 'not_confirmed', 'expired') AND NEW.delivered_at IS NOT DISTINCT FROM OLD.delivered_at AND NEW.acked_at IS NOT NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'engine_commands: not a transition a runner can make' USING ERRCODE = 'insufficient_privilege';
END;
$$;
REVOKE ALL ON FUNCTION engine_commands_guard_update() FROM PUBLIC;

CREATE TRIGGER engine_commands_guard_update
  BEFORE UPDATE ON engine_commands
  FOR EACH ROW EXECUTE FUNCTION engine_commands_guard_update();
