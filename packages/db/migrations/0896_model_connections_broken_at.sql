-- D#6 DB-IDLE-R1b: when a model connection broke.
--
-- The reconcile cron re-checks a connection broken for out-of-credit every 15 minutes, which keeps the database awake for as long as an
-- account never tops up. The re-check backs off to hourly once the break is two hours old, so the row needs to say when it broke.
--
-- 1. model_connections.broken_at: nullable timestamptz. Set by platform_ops code when the connection goes to 'broken' (COALESCE keeps the
--    first time while it stays broken), cleared when it reads 'ok' again and when the key is replaced. Rows already broken are backfilled
--    with now(): their real time is unknown, so each starts a fresh two-hour window and backs off from there.
-- 2. platform_ops reads and writes that one column and nothing else new. app_user holds a table-wide UPDATE, so the write guard (0800)
--    is replaced with the same body plus broken_at: only platform_ops may set or change it, a new row starts without it, and a key or
--    provider change from a tenant clears it together with the status it belonged to.
--
-- The guard function stays owned by the migration role (CREATE OR REPLACE does not change the owner) and restates the pinned search_path
-- from 0601, which the replacement would otherwise drop.
--
-- Expand-only: one nullable column with no default; nothing is dropped, renamed or narrowed. Numbered above the highest migration on the
-- code plane (0895). Re-check right before the pull request is opened and again before merging.
ALTER TABLE model_connections ADD COLUMN broken_at timestamptz;

-- The backfill touches no key and must not fire the onboarding-mark or guard triggers (they key off status and key changes).
ALTER TABLE model_connections DISABLE TRIGGER USER;
UPDATE model_connections SET broken_at = now() WHERE status = 'broken';
ALTER TABLE model_connections ENABLE TRIGGER USER;

GRANT SELECT (broken_at), UPDATE (broken_at) ON model_connections TO platform_ops;

CREATE OR REPLACE FUNCTION model_connections_guard_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- Deny by default: guard everyone except a role that is actually, usably a member of platform_ops, checked by real
  -- membership rather than by CURRENT_USER text equality. A superuser satisfies pg_has_role() unconditionally.
  IF pg_has_role(current_user, 'platform_ops', 'USAGE') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'unvalidated'
       OR NEW.last_validated_at IS NOT NULL
       OR NEW.last_error_code IS NOT NULL
       OR NEW.health_strikes IS DISTINCT FROM 0
       OR NEW.broken_at IS NOT NULL
    THEN
      RAISE EXCEPTION
        'model_connections: only platform_ops may set status/last_validated_at/last_error_code/health_strikes/broken_at -- new connections always start unvalidated'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.last_validated_at IS DISTINCT FROM OLD.last_validated_at
       OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code
       OR NEW.health_strikes IS DISTINCT FROM OLD.health_strikes
       OR NEW.broken_at IS DISTINCT FROM OLD.broken_at
    THEN
      RAISE EXCEPTION
        'model_connections: only platform_ops may change status/last_validated_at/last_error_code/health_strikes/broken_at -- a tenant cannot self-attest a key as validated'
        USING ERRCODE = 'check_violation';
    END IF;

    -- Any key-material, provider or credential-kind change from a non-platform_ops caller drops the row back to
    -- unvalidated, whatever status the caller submitted, forgets any strike the old key had earned, and forgets when it broke.
    IF NEW.key_ciphertext IS DISTINCT FROM OLD.key_ciphertext
       OR NEW.key_nonce IS DISTINCT FROM OLD.key_nonce
       OR NEW.wrapped_dek IS DISTINCT FROM OLD.wrapped_dek
       OR NEW.kek_version IS DISTINCT FROM OLD.kek_version
       OR NEW.key_fingerprint IS DISTINCT FROM OLD.key_fingerprint
       OR NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.credential_kind IS DISTINCT FROM OLD.credential_kind
       OR NEW.aad_version IS DISTINCT FROM OLD.aad_version
    THEN
      NEW.status := 'unvalidated';
      NEW.last_validated_at := NULL;
      NEW.last_error_code := NULL;
      NEW.health_strikes := 0;
      NEW.broken_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
