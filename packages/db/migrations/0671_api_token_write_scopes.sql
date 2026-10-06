-- D#31 API-15: the api_tokens.scopes CHECK admits the two write scopes,
-- work_items:write and discussions:write.
--
-- Numbered 0671: 0669 is taken by open PR #281 and 0670 by the in-flight
-- H26a work; re-checked against main and every open PR right before pushing.
--
-- 0616 declared the CHECK inline and unnamed, so it is found by its
-- definition in pg_constraint rather than by a guessed name. The DO block
-- drops exactly one constraint and raises if it matches zero or several, so a
-- drifted schema fails loudly instead of leaving two CHECKs or none. Existing
-- rows already satisfy the wider set and are untouched.

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
     AND pg_get_constraintdef(oid) LIKE '%runs:cancel%'
     AND pg_get_constraintdef(oid) LIKE '%cardinality(scopes)%';

  IF found_count <> 1 THEN
    RAISE EXCEPTION 'api_tokens scopes CHECK: expected exactly one match, found %', found_count;
  END IF;

  EXECUTE format('ALTER TABLE public.api_tokens DROP CONSTRAINT %I', found_name);
END
$$;

ALTER TABLE public.api_tokens
  ADD CONSTRAINT api_tokens_scopes_check CHECK (
    scopes <@ ARRAY['read', 'runs:cancel', 'audit:read', 'work_items:write', 'discussions:write']::text[]
    AND cardinality(scopes) > 0
  );
