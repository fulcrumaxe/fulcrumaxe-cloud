-- D#31 API-5d: an immediate feed wake-up for token and sign-out-everywhere events.
--
-- The event feeds poll every 10 s while an account has no run in flight, so a
-- device that is idle would hear of "sign out everywhere" or a token change up
-- to 10 s late. The writers and the streams run in different processes, so the
-- wake has to go through the database: on commit, an INSERT of one of three
-- auth-related event types sends a NOTIFY on `fx_account_nudge`, and each
-- process's listener (packages/api/src/sse/nudge.ts) wakes that account's feed.
--
--   * The payload is the account id and nothing else: no type, subject or
--     payload, so a listener learns only "look at this account".
--   * Only three types notify. Postgres serializes every notifying
--     transaction on the notification queue at commit, so a broader list
--     would add commit-time contention for every event producer. The list
--     here must equal NUDGE_EVENT_TYPES in nudge.ts (a test compares them).
--   * NOTIFY is delivered only at commit (a rollback delivers nothing), and
--     identical notifications inside one transaction arrive once.
--   * The trigger adds no domain_events write: pg_notify only queues a
--     message, so nothing slow runs after the emitting statement.
--
-- SECURITY INVOKER with a pinned search_path: it runs with the inserting role's
-- rights and needs none beyond those the INSERT already required.

CREATE FUNCTION domain_events_nudge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM pg_notify('fx_account_nudge', NEW.account_id::text);
  RETURN NULL;
END;
$$;

CREATE TRIGGER domain_events_nudge
  AFTER INSERT ON domain_events
  FOR EACH ROW
  WHEN (NEW.type IN ('session.revoked', 'api_token.created', 'api_token.revoked'))
  EXECUTE FUNCTION domain_events_nudge();
