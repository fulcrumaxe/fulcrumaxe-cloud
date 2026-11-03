-- D#597 CC-5c: the assistant's per-conversation cost store.
--
-- One row per conversation holds only money and ids: the cap fixed when the conversation began, what has been spent, what is held back
-- for turns in flight, and a turn count. No message text is stored here (the client keeps the turns), so no correction or repo text
-- lands in this table.
--
-- Every admitted turn has its own row in assistant_conversation_holds. Admission (`charge`) locks the conversation row, then holds the
-- turn's worst case only while spent + reserved + worst case <= cap, so two turns racing at the cap cannot both pass; it returns the
-- hold's id. Settlement (`settle`) takes that id and settles that hold at most once: it moves exactly that hold out of `reserved` and
-- books the FULL real cost into `spent`. A real cost above the hold is recorded in full, so `spent` may pass the cap; admission then
-- refuses every further turn (spent + reserved + worst case > cap). A second settle, or a hold of another conversation, is refused with
-- the fixed message assistant_hold_refused and changes nothing.
-- A hold still unsettled 20 minutes after it was made (a turn whose process died) is released the next time `charge` runs on the same
-- conversation; no job does it. The TTL (c_hold_ttl in `charge`) must stay above the longest route (800 s) plus margin, or a live turn's
-- hold could be released. A late settle of a released hold still books its real cost into `spent`, exactly once, and releases no reserve
-- (none is left); the hold is then marked settled, so a repeat is refused.
--
-- app_user can read and insert conversations; only the two SECURITY DEFINER functions move the money (no UPDATE, no DELETE for
-- app_user, no access at all to the holds). A conversation is visible to its creator and to an owner or admin of the account, and only
-- while the account is active. The functions are owned by platform_ops through the same bracket 0971 uses; their pinned search_path is
-- pg_catalog, public, pg_temp.

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE TABLE assistant_conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id          uuid NOT NULL,
  work_item_id     uuid,
  created_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  cap_micro_usd    bigint NOT NULL,
  spent_micro_usd  bigint NOT NULL DEFAULT 0,
  reserved_micro_usd bigint NOT NULL DEFAULT 0,
  turns            integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE,
  CONSTRAINT assistant_conversations_cap_check CHECK (cap_micro_usd > 0),
  CONSTRAINT assistant_conversations_spent_check CHECK (spent_micro_usd >= 0 AND reserved_micro_usd >= 0),
  CONSTRAINT assistant_conversations_turns_check CHECK (turns >= 0)
);
CREATE INDEX assistant_conversations_account_idx ON assistant_conversations (account_id, created_at DESC, id);

CREATE TABLE assistant_conversation_holds (
  hold_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL,
  conversation_id  uuid NOT NULL,
  held_micro_usd   bigint NOT NULL CHECK (held_micro_usd >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  settled_at       timestamptz,
  released_at      timestamptz,
  FOREIGN KEY (account_id, conversation_id) REFERENCES assistant_conversations (account_id, id) ON DELETE CASCADE
);
CREATE INDEX assistant_conversation_holds_open_idx ON assistant_conversation_holds (conversation_id, created_at) WHERE settled_at IS NULL AND released_at IS NULL;
ALTER TABLE assistant_conversation_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_conversation_holds FORCE ROW LEVEL SECURITY;

ALTER TABLE assistant_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_conversations FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON assistant_conversations TO app_user;

CREATE POLICY tenant_select ON assistant_conversations FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND EXISTS (
      SELECT 1 FROM account_members m
       WHERE m.account_id = assistant_conversations.account_id
         AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
         AND (m.role IN ('owner', 'admin') OR m.user_id = assistant_conversations.created_by)
    )
  );
CREATE POLICY tenant_insert ON assistant_conversations FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND created_by = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND spent_micro_usd = 0 AND reserved_micro_usd = 0 AND turns = 0
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND EXISTS (
      SELECT 1 FROM account_members m
       WHERE m.account_id = assistant_conversations.account_id AND m.user_id = assistant_conversations.created_by
    )
  );

-- The functions run as platform_ops, which needs its own narrow policies and column grants on the two tables.
CREATE POLICY platform_ops_charge ON assistant_conversations TO platform_ops
  USING (true) WITH CHECK (true);
CREATE POLICY platform_ops_charge ON assistant_conversation_holds TO platform_ops
  USING (true) WITH CHECK (true);
GRANT SELECT (id, account_id, created_by, cap_micro_usd, spent_micro_usd, reserved_micro_usd, turns),
      UPDATE (spent_micro_usd, reserved_micro_usd, turns, updated_at) ON assistant_conversations TO platform_ops;
GRANT SELECT (hold_id, account_id, conversation_id, held_micro_usd, created_at, settled_at, released_at),
      INSERT (account_id, conversation_id, held_micro_usd),
      UPDATE (settled_at, released_at) ON assistant_conversation_holds TO platform_ops;

GRANT CREATE ON SCHEMA public TO platform_ops;

-- Charge: hold back a turn's worst case. The caller must be the conversation's creator, a member of an active account (taken from
-- app.account_id and app.user_id, never an argument). Returns the new hold's id, or NULL when the turn does not fit under the cap.
-- An unknown conversation, another account's and another member's all raise, so nothing is charged and nothing is revealed.
-- The conversation row is locked first, so concurrent charges on it take turns and the second sees the first's hold.
CREATE FUNCTION assistant_conversation_charge(p_id uuid, p_worst_micro_usd bigint)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v_id uuid;
  v_dead bigint;
  v_hold uuid;
  -- Must exceed the longest route (800 s) plus margin: a live turn's hold must never be released under it.
  c_hold_ttl constant interval := interval '20 minutes';
BEGIN
  IF acct IS NULL OR usr IS NULL OR p_id IS NULL OR p_worst_micro_usd IS NULL OR p_worst_micro_usd < 0
     OR NOT public.account_is_active(acct)
     OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr) THEN
    RAISE EXCEPTION 'assistant_conversation_charge: refused' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT c.id INTO v_id FROM public.assistant_conversations c
   WHERE c.id = p_id AND c.account_id = acct AND c.created_by = usr FOR UPDATE;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'assistant_conversation_charge: refused' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Dead holds (unsettled after c_hold_ttl) are released here, on the next charge for this conversation.
  WITH dead AS (
    UPDATE public.assistant_conversation_holds h SET released_at = now()
     WHERE h.conversation_id = p_id AND h.settled_at IS NULL AND h.released_at IS NULL AND h.created_at < now() - c_hold_ttl
    RETURNING h.held_micro_usd
  )
  SELECT COALESCE(sum(held_micro_usd), 0) INTO v_dead FROM dead;
  IF v_dead > 0 THEN
    UPDATE public.assistant_conversations c SET reserved_micro_usd = c.reserved_micro_usd - v_dead, updated_at = now() WHERE c.id = p_id;
  END IF;
  UPDATE public.assistant_conversations c
     SET reserved_micro_usd = c.reserved_micro_usd + p_worst_micro_usd, turns = c.turns + 1, updated_at = now()
   WHERE c.id = p_id AND c.spent_micro_usd + c.reserved_micro_usd + p_worst_micro_usd <= c.cap_micro_usd;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.assistant_conversation_holds (account_id, conversation_id, held_micro_usd)
  VALUES (acct, p_id, p_worst_micro_usd) RETURNING hold_id INTO v_hold;
  RETURN v_hold;
END;
$$;

-- Settle: settle ONE hold, once, at the real cost (NULL = the held amount, for a turn that reported no usage). Exactly that hold leaves
-- `reserved`; the full real cost is added to `spent`. A hold that is unknown, belongs to another conversation or was already settled
-- was settled raises assistant_hold_refused and changes nothing. Returns the new spent total.
CREATE FUNCTION assistant_conversation_settle(p_id uuid, p_hold_id uuid, p_actual_micro_usd bigint)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v_id uuid;
  v_held bigint;
  v_released timestamptz;
  v_spent bigint;
BEGIN
  IF acct IS NULL OR usr IS NULL OR p_id IS NULL OR p_hold_id IS NULL OR (p_actual_micro_usd IS NOT NULL AND p_actual_micro_usd < 0)
     OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr) THEN
    RAISE EXCEPTION 'assistant_conversation_settle: refused' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT c.id INTO v_id FROM public.assistant_conversations c
   WHERE c.id = p_id AND c.account_id = acct AND c.created_by = usr FOR UPDATE;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'assistant_conversation_settle: refused' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.assistant_conversation_holds h SET settled_at = now()
   WHERE h.hold_id = p_hold_id AND h.conversation_id = p_id AND h.account_id = acct AND h.settled_at IS NULL
  RETURNING h.held_micro_usd, h.released_at INTO v_held, v_released;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'assistant_hold_refused';
  END IF;
  UPDATE public.assistant_conversations c
     SET reserved_micro_usd = c.reserved_micro_usd - CASE WHEN v_released IS NULL THEN v_held ELSE 0 END,
         spent_micro_usd = c.spent_micro_usd + COALESCE(p_actual_micro_usd, v_held),
         updated_at = now()
   WHERE c.id = p_id
  RETURNING c.spent_micro_usd INTO v_spent;
  RETURN v_spent;
END;
$$;

REVOKE ALL ON FUNCTION assistant_conversation_charge(uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant_conversation_settle(uuid, uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assistant_conversation_charge(uuid, bigint) TO app_user;
GRANT EXECUTE ON FUNCTION assistant_conversation_settle(uuid, uuid, bigint) TO app_user;
ALTER FUNCTION assistant_conversation_charge(uuid, bigint) OWNER TO platform_ops;
ALTER FUNCTION assistant_conversation_settle(uuid, uuid, bigint) OWNER TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
