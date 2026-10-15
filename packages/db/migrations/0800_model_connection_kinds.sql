-- D#221 MC1: what a model connection is FOR and what KIND of credential it holds.
--
-- 1. provider gains 'openai' (one fixed HTTPS host, api.openai.com, mapped in the model-connection package like the other
--    two). The CHECK is replaced under its own name.
-- 2. credential_kind: which credential this row holds. 'ai_gateway' and 'anthropic' are the two that exist today (a row's
--    kind equals its provider, so every existing row is backfilled that way). 'openai_api_key', 'codex_access_token' and
--    'chatgpt_oauth' are the OpenAI kinds. The last two are plan-based kinds: defined here, connected by later changes,
--    and refused at admit unless the kill switch is on and the notice is acknowledged (model-connection credentialPolicy).
--    A CHECK ties kind to provider, so a row can never claim a kind its provider does not carry.
-- 3. backend: the agent backend this connection is meant for (the account default that selection will resolve). Same shape
--    rule as agent_runs.backend (0735); which names are selectable is the runner registry's call, not this column's.
-- 4. aad_version: which envelope AAD the key was sealed under. 1 is the original (account, row, 'model_key'), which binds
--    no kind and cannot be re-sealed here because the migration holds no key. 2 binds credential_kind as well, so a sealed
--    row cannot be swapped into another kind (CWE-441). Existing rows stay at 1 until their key is next replaced; every
--    new seal is 2. A CHECK keeps version 1 to the two legacy kinds, so an OpenAI row can only ever be version 2.
--
-- The kind is filled from the provider on an INSERT that omits it (the two legacy providers only): code and fixtures that
-- insert a row by provider keep working, and an INSERT for 'openai' must name its kind.
--
-- The write guard (0743) already resets status, last_validated_at, last_error_code and health_strikes when the key
-- material or provider changes under a non-platform_ops caller. It is replaced here with the same body plus credential_kind
-- and aad_version in that set, so retagging a row cannot carry an 'ok' status over to a credential nobody validated.
-- backend is a selection, not a credential, and does not reset anything. The function stays owned by the migration role and
-- keeps the pinned search_path.
ALTER TABLE model_connections DROP CONSTRAINT model_connections_provider_check;
ALTER TABLE model_connections
  ADD CONSTRAINT model_connections_provider_check CHECK (provider IN ('ai_gateway', 'anthropic', 'openai'));

ALTER TABLE model_connections
  ADD COLUMN backend text NOT NULL DEFAULT 'claude-code',
  ADD COLUMN credential_kind text,
  ADD COLUMN aad_version smallint NOT NULL DEFAULT 1;

-- The backfill touches no key and must not fire the onboarding-mark or guard triggers (they key off status and key changes).
ALTER TABLE model_connections DISABLE TRIGGER USER;
UPDATE model_connections SET credential_kind = provider;
ALTER TABLE model_connections ENABLE TRIGGER USER;

-- Expand step (docs/ops/runbooks/rollback.md, "expand now, contract later"): credential_kind stays nullable at the column
-- level so the previous deploy, which does not name it on INSERT, still writes (the BEFORE INSERT trigger below fills it).
-- A CHECK keeps NULL out all the same; without it the two CHECKs after it would let a NULL through (a NULL operand makes
-- the whole predicate NULL, which a CHECK accepts). SET NOT NULL belongs to a later contract migration marked
-- 'contract-phase: PR #228', once no deployment that can be rolled back to omits the column.
ALTER TABLE model_connections
  ADD CONSTRAINT model_connections_credential_kind_present_check CHECK (credential_kind IS NOT NULL),
  ADD CONSTRAINT model_connections_backend_name_check CHECK (backend ~ '^[a-z][a-z0-9-]{0,31}$'),
  ADD CONSTRAINT model_connections_aad_version_check CHECK (aad_version IN (1, 2)),
  ADD CONSTRAINT model_connections_kind_provider_check CHECK (
    (provider = 'ai_gateway' AND credential_kind = 'ai_gateway')
    OR (provider = 'anthropic' AND credential_kind = 'anthropic')
    OR (provider = 'openai' AND credential_kind IN ('openai_api_key', 'codex_access_token', 'chatgpt_oauth'))
  ),
  ADD CONSTRAINT model_connections_aad_version_kind_check CHECK (
    aad_version = 2 OR credential_kind IN ('ai_gateway', 'anthropic')
  );

CREATE FUNCTION model_connections_default_kind()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.credential_kind IS NULL AND NEW.provider IN ('ai_gateway', 'anthropic') THEN
    NEW.credential_kind := NEW.provider;
  END IF;
  RETURN NEW;
END;
$$;

-- A trigger function needs no EXECUTE for the role whose statement fires it, so nobody is granted it (as in 0720).
REVOKE ALL ON FUNCTION model_connections_default_kind() FROM PUBLIC;

CREATE TRIGGER model_connections_default_kind
  BEFORE INSERT ON model_connections
  FOR EACH ROW
  EXECUTE FUNCTION model_connections_default_kind();

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

    -- Any key-material, provider or credential-kind change from a non-platform_ops caller drops the row back to
    -- unvalidated, whatever status the caller submitted, and forgets any strike the old key had earned.
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
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
