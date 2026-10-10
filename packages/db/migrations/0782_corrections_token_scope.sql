-- D#597 CC-2a: the api_tokens.scopes CHECK admits corrections:write (propose, and with an owner or admin as creator, decide a
-- correction). Same shape as 0671: the unnamed-by-guess CHECK is found by its definition, exactly one is dropped, and a drifted
-- schema fails loudly. Existing rows already satisfy the wider set.

DO $$
DECLARE
  found_name text;
  found_count integer;
BEGIN
  SELECT count(*), min(conname)
    INTO found_count, found_name
    FROM pg_constraint
   WHERE conrelid = 'public.api_tokens'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%discussions:write%'
     AND pg_get_constraintdef(oid) LIKE '%cardinality(scopes)%';

  IF found_count <> 1 THEN
    RAISE EXCEPTION 'api_tokens scopes CHECK: expected exactly one match, found %', found_count;
  END IF;

  EXECUTE format('ALTER TABLE public.api_tokens DROP CONSTRAINT %I', found_name);
END
$$;

ALTER TABLE public.api_tokens
  ADD CONSTRAINT api_tokens_scopes_check CHECK (
    scopes <@ ARRAY['read', 'runs:cancel', 'audit:read', 'work_items:write', 'discussions:write', 'corrections:write']::text[]
    AND cardinality(scopes) > 0
  );
