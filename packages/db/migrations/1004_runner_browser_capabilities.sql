-- D#749 V2a: the deploy order, and the two runner capabilities of the post-merge verify stage.
--
-- 1. verify_deploy_orders. The cloud's record that a merged commit of a repository should be deployed by a runner on that repository's own machine. THE CLOUD CAN ONLY
--    SAY "DEPLOY SHA X OF REPOSITORY R": the table has no column for a command, an argument, a path, a URL or a credential, and the deploy command lives in the runner's
--    own local configuration. What a runner sends back (an exit status, a closed failure code, the last lines of output after it scrubbed secrets) is stored as data.
--
--      state   pending -> claimed -> succeeded | failed
--                 \         \-> claimed again (a lapsed lease is taken over: lease_generation and attempts both grow by one, at most 3 attempts)
--                  \         \-> expired | cancelled
--                   \-> expired | cancelled        Terminal states (succeeded, failed, expired, cancelled) never change again.
--      lease   a claim leases the order to one runner for a while; `lease_generation` counts claims and the runner names it on its report (a stale generation is fenced).
--      one     at most one open order per (repository, merge commit): placing the same order twice is the unique index, not a second deploy.
--
--    Who may write what is enforced here, not only in the application. A trigger lets the CLOUD (a tenant session with no runner in it) place an order and end it unclaimed
--    (expired, cancelled); and lets a RUNNER (the session names it as app.runner_id) do only two things: claim an order it is eligible for (a live runner of the account, the
--    repository in its list, `deploy_order_v1` on its latest hello) and report on the order it holds under the lease generation it holds. A runner session cannot place, cancel or
--    expire an order, and cannot report on another runner's. No SECURITY DEFINER function is added; the writes go through the tenant policy as app_user.
--
--    `verify_row_id` names the verify row the order belongs to. It has no foreign key: the verify row table is a sibling migration (1003) and the order must apply and be tested
--    without it; the row is created first, so the id exists when the order is placed (the stage that places the order is a later change).
--
-- 2. Two runner capabilities. 'browser_chrome_v1' gates the deploy verifier role (the job is offered only to a runner whose latest hello listed it); 'deploy_order_v1' gates no role
--    (the runner may claim and report a deploy order). The table's CHECK and runner_capabilities_record's closed list widen by these two values, from the ten of 0985; everything
--    else of the function is 0985's, verbatim (same signature, owner, pinned search_path, grants and the ADMIN-option bracket).
--
-- Expand-only: one new table, and a CHECK and a closed list widened by two values. The number is the next free one above main's highest (1002) and the number the sibling verify
-- data migration holds (1003); the Team Lead re-checks it at merge, and merges go in number order.

CREATE TABLE verify_deploy_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id           uuid NOT NULL,
  verify_row_id     uuid NOT NULL,
  -- The commit to deploy: the merge commit, 40 or 64 lowercase hex.
  merge_sha         text NOT NULL CONSTRAINT verify_deploy_orders_sha_check CHECK (merge_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  state             text NOT NULL DEFAULT 'pending'
    CONSTRAINT verify_deploy_orders_state_check CHECK (state IN ('pending', 'claimed', 'succeeded', 'failed', 'expired', 'cancelled')),
  runner_id         uuid,
  lease_generation  integer NOT NULL DEFAULT 0 CONSTRAINT verify_deploy_orders_generation_check CHECK (lease_generation >= 0),
  lease_expires_at  timestamptz,
  attempts          integer NOT NULL DEFAULT 0 CONSTRAINT verify_deploy_orders_attempts_check CHECK (attempts BETWEEN 0 AND 3),
  -- What the runner reported. The exit status of the deploy command, a closed code for a failure, and the last lines of its output (data to show, never to act on).
  exit_code         integer CONSTRAINT verify_deploy_orders_exit_check CHECK (exit_code BETWEEN 0 AND 255),
  failure_code      text CONSTRAINT verify_deploy_orders_failure_check CHECK (failure_code IN ('not_configured', 'script_refused', 'spawn_failed', 'exit_nonzero', 'timeout')),
  output_tail       text CONSTRAINT verify_deploy_orders_tail_check CHECK (char_length(output_tail) <= 4100),
  deadline_at       timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,

  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE SET NULL (runner_id),

  -- A leased order has a lease (its runner column is nulled if the runner row is deleted, and no runner then matches the fence); a waiting order has none, and a lease is one claim.
  CONSTRAINT verify_deploy_orders_lease_shape CHECK (
    (state = 'pending' AND runner_id IS NULL AND lease_expires_at IS NULL AND lease_generation = 0)
    OR (state = 'claimed' AND lease_generation >= 1 AND lease_expires_at IS NOT NULL)
    OR state NOT IN ('pending', 'claimed')),
  CONSTRAINT verify_deploy_orders_attempts_match CHECK (attempts = lease_generation),
  -- What was reported goes with the result: a success is exit status 0 and no failure code; a failure names its code; an order that was not run reports nothing.
  CONSTRAINT verify_deploy_orders_result_shape CHECK (
    (state = 'succeeded' AND exit_code IS NOT NULL AND exit_code = 0 AND failure_code IS NULL)
    OR (state = 'failed' AND failure_code IS NOT NULL AND ((failure_code = 'exit_nonzero') = (exit_code IS NOT NULL)) AND (exit_code IS NULL OR exit_code > 0))
    OR (state NOT IN ('succeeded', 'failed') AND exit_code IS NULL AND failure_code IS NULL AND output_tail IS NULL)),
  CONSTRAINT verify_deploy_orders_finished_shape CHECK ((state IN ('succeeded', 'failed', 'expired', 'cancelled')) = (finished_at IS NOT NULL))
);

-- At most one open order per (repository, merge commit).
CREATE UNIQUE INDEX verify_deploy_orders_one_open ON verify_deploy_orders (account_id, repo_id, merge_sha) WHERE state IN ('pending', 'claimed');
-- The claim looks for the oldest waiting order of an account.
CREATE INDEX verify_deploy_orders_waiting ON verify_deploy_orders (account_id, created_at, id) WHERE state IN ('pending', 'claimed');
CREATE INDEX verify_deploy_orders_by_row ON verify_deploy_orders (account_id, verify_row_id, created_at DESC);

-- The clock, and the rules that make the table what the header says. SECURITY INVOKER: the tenant policy applies to the reads it makes.
CREATE FUNCTION verify_deploy_orders_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  raw    text := lower(COALESCE(current_setting('app.runner_id', true), ''));
  sess   uuid := CASE WHEN raw ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN raw::uuid END;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The cloud places an order. A runner session never does.
    IF raw <> '' THEN
      RAISE EXCEPTION 'verify_deploy_orders: a runner does not place an order' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- And it places a fresh one: pending, no runner, no lease, nothing reported.
    IF NEW.state <> 'pending' OR NEW.runner_id IS NOT NULL OR NEW.lease_generation <> 0 OR NEW.attempts <> 0 OR NEW.lease_expires_at IS NOT NULL
       OR NEW.exit_code IS NOT NULL OR NEW.failure_code IS NOT NULL OR NEW.output_tail IS NOT NULL OR NEW.finished_at IS NOT NULL THEN
      RAISE EXCEPTION 'verify_deploy_orders: an order is placed pending, with nothing claimed or reported' USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  NEW.updated_at := now();
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.repo_id IS DISTINCT FROM OLD.repo_id
     OR NEW.verify_row_id IS DISTINCT FROM OLD.verify_row_id OR NEW.merge_sha IS DISTINCT FROM OLD.merge_sha
     OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'verify_deploy_orders: identity is fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state IN ('succeeded', 'failed', 'expired', 'cancelled') THEN
    RAISE EXCEPTION 'verify_deploy_orders: a finished order does not change' USING ERRCODE = 'check_violation';
  END IF;

  -- The runner row was deleted: the foreign key nulls the runner column and nothing else moves.
  IF NEW.runner_id IS NULL AND OLD.runner_id IS NOT NULL AND NEW.state = OLD.state AND NEW.lease_generation = OLD.lease_generation
     AND NEW.lease_expires_at IS NOT DISTINCT FROM OLD.lease_expires_at AND NEW.attempts = OLD.attempts THEN
    RETURN NEW;
  END IF;

  IF NEW.state = 'claimed' AND (OLD.state = 'pending' OR (OLD.state = 'claimed' AND NEW.lease_generation IS DISTINCT FROM OLD.lease_generation)) THEN
    -- A claim, or the takeover of a lapsed lease: by the runner the session names, and only one that may take this order.
    IF sess IS NULL OR NEW.runner_id IS DISTINCT FROM sess THEN
      RAISE EXCEPTION 'verify_deploy_orders: only the runner itself claims an order' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.state = 'claimed' AND OLD.lease_expires_at > now() THEN
      RAISE EXCEPTION 'verify_deploy_orders: the lease has not lapsed' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.deadline_at <= now() THEN
      RAISE EXCEPTION 'verify_deploy_orders: the order is past its deadline' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.lease_generation <> OLD.lease_generation + 1 OR NEW.attempts <> OLD.attempts + 1 THEN
      RAISE EXCEPTION 'verify_deploy_orders: a claim counts one lease and one attempt' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.runners rn JOIN public.runner_capabilities cap ON cap.account_id = rn.account_id AND cap.runner_id = rn.id
       WHERE rn.id = sess AND rn.account_id = OLD.account_id AND rn.revoked_at IS NULL
         AND OLD.repo_id = ANY (rn.allowed_repo_ids) AND 'deploy_order_v1' = ANY (cap.capabilities)) THEN
      RAISE EXCEPTION 'verify_deploy_orders: this runner may not take this order' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF OLD.state = 'claimed' AND NEW.state IN ('succeeded', 'failed') THEN
    -- A report: by the runner that holds the lease, under the generation it holds, before the lease ends.
    IF sess IS NULL OR OLD.runner_id IS DISTINCT FROM sess THEN
      RAISE EXCEPTION 'verify_deploy_orders: only the runner that holds the order reports on it' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.lease_expires_at <= now() THEN
      RAISE EXCEPTION 'verify_deploy_orders: the lease has ended' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.runner_id IS DISTINCT FROM OLD.runner_id OR NEW.lease_generation <> OLD.lease_generation OR NEW.attempts <> OLD.attempts
       OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at THEN
      RAISE EXCEPTION 'verify_deploy_orders: a report does not move the lease' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.state IN ('expired', 'cancelled') AND OLD.state IN ('pending', 'claimed') THEN
    -- The cloud ends an order that was not run. A runner session never does.
    IF raw <> '' THEN
      RAISE EXCEPTION 'verify_deploy_orders: a runner does not end an order' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.runner_id IS DISTINCT FROM OLD.runner_id OR NEW.lease_generation <> OLD.lease_generation OR NEW.attempts <> OLD.attempts
       OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at THEN
      RAISE EXCEPTION 'verify_deploy_orders: ending an order does not move the lease' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'verify_deploy_orders: % cannot become %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  ELSE
    -- No move: nothing may change.
    IF NEW.runner_id IS DISTINCT FROM OLD.runner_id OR NEW.lease_generation <> OLD.lease_generation OR NEW.attempts <> OLD.attempts
       OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at OR NEW.exit_code IS DISTINCT FROM OLD.exit_code
       OR NEW.failure_code IS DISTINCT FROM OLD.failure_code OR NEW.output_tail IS DISTINCT FROM OLD.output_tail OR NEW.finished_at IS DISTINCT FROM OLD.finished_at THEN
      RAISE EXCEPTION 'verify_deploy_orders: an order changes only by a claim, a report or an end' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER verify_deploy_orders_guard BEFORE INSERT OR UPDATE ON verify_deploy_orders
  FOR EACH ROW EXECUTE FUNCTION verify_deploy_orders_guard();

ALTER TABLE verify_deploy_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE verify_deploy_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON verify_deploy_orders TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
REVOKE ALL ON verify_deploy_orders FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON verify_deploy_orders TO app_user;
REVOKE ALL ON FUNCTION verify_deploy_orders_guard() FROM PUBLIC;

ALTER TABLE runner_capabilities DROP CONSTRAINT runner_capabilities_values_check;
ALTER TABLE runner_capabilities ADD CONSTRAINT runner_capabilities_values_check
  CHECK (array_ndims(capabilities) IS NULL OR (array_ndims(capabilities) = 1 AND capabilities <@ ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1']::text[]));

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
     OR EXISTS (SELECT 1 FROM unnest(p_capabilities) c WHERE c IS NULL OR c <> ALL (ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1']))
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
