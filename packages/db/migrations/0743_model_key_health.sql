-- D#454 H2e: the model-key health job (daily, one call per connection).
--
-- 1. model_connections.health_strikes counts consecutive rejections seen by the health job. One 401 is a strike and
--    changes nothing a user can see; a second marks the key broken. A 200 clears it, and so does a new key.
-- 2. platform_ops may read and write that one column. It reads it because the job decides on its value under the row
--    lock; the key columns stay ungranted (key_nonce is the one extra column it already had, 0006).
-- 3. The guard trigger is amended with CREATE OR REPLACE: everything it did before is kept, a rotation also resets the
--    strike count, and a tenant can no longer set the count itself (app_user holds a table-wide UPDATE).
-- 4. The job's reconcile_jobs row.
--
-- The guard function stays owned by the migration role (CREATE OR REPLACE does not change the owner, and 0720 never
-- moved it), and keeps the pinned search_path from 0601, which the replacement has to restate because it replaces the
-- function's settings along with its body.
ALTER TABLE model_connections
  ADD COLUMN health_strikes smallint NOT NULL DEFAULT 0 CHECK (health_strikes >= 0);

GRANT SELECT (health_strikes), UPDATE (health_strikes) ON model_connections TO platform_ops;

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
    THEN
      RAISE EXCEPTION
        'model_connections: only platform_ops may set status/last_validated_at/last_error_code/health_strikes -- new connections always start unvalidated'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.last_validated_at IS DISTINCT FROM OLD.last_validated_at
       OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code
       OR NEW.health_strikes IS DISTINCT FROM OLD.health_strikes
    THEN
      RAISE EXCEPTION
        'model_connections: only platform_ops may change status/last_validated_at/last_error_code/health_strikes -- a tenant cannot self-attest a key as validated'
        USING ERRCODE = 'check_violation';
    END IF;

    -- Any key-material or provider change from a non-platform_ops caller drops the row back to unvalidated, whatever
    -- status the caller submitted, and (new) forgets any strike the old key had earned.
    IF NEW.key_ciphertext IS DISTINCT FROM OLD.key_ciphertext
       OR NEW.key_nonce IS DISTINCT FROM OLD.key_nonce
       OR NEW.wrapped_dek IS DISTINCT FROM OLD.wrapped_dek
       OR NEW.kek_version IS DISTINCT FROM OLD.kek_version
       OR NEW.key_fingerprint IS DISTINCT FROM OLD.key_fingerprint
       OR NEW.provider IS DISTINCT FROM OLD.provider
    THEN
      NEW.status := 'unvalidated';
      NEW.last_validated_at := NULL;
      NEW.last_error_code := NULL;
      NEW.health_strikes := 0;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

INSERT INTO reconcile_jobs (name, interval_seconds) VALUES ('model_key_health', 86400);
