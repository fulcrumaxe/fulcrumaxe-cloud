-- D#31 API-3g (C20): an optional, immutable, human label on an API token.
--
-- Number re-checked against origin/main and every open PR at push time
-- (D#94 R1); 0616 and 0621 are merged and not edited.
--
-- NULL for every existing row, and for any new token minted without a name.
-- The route (packages/api/src/routes/tokens.ts) enforces the full rule set
-- (1-64 code points, no leading/trailing whitespace, no C1/bidi/line
-- separators); this CHECK is the defense-in-depth backstop for the part
-- that is cheap to say in SQL: 1-64 characters and no C0 control or DEL.
-- (NUL cannot occur in a Postgres text value at all.)
--
-- Immutable by construction: 0621 left app_user's column-level UPDATE grant
-- at (revoked_at, revoked_reason), and this migration adds no grant, so a
-- rename is a permission error. The name plays no part in lookup, scopes,
-- revocation or RLS: no index, no uniqueness, no policy reads it.

ALTER TABLE api_tokens
  ADD COLUMN name text NULL
  CONSTRAINT api_tokens_name_check CHECK (
    name IS NULL
    OR (char_length(name) BETWEEN 1 AND 64 AND name !~ '[\u0001-\u001f\u007f]')
  );
