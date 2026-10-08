-- D#483 S3-F3: plan_imports.error_code gains 'plan_source_too_large', the code an import ends with when a Spec-shaped
-- Discussion bound (600) or a Spec's Correction-comment bound (300) is passed. Only the CHECK is replaced (DROP then ADD in
-- one transaction); every existing row already holds one of the old values, so the new CHECK validates against all of them.
-- The value set must equal ImportErrorCode in packages/core/src/plan/persist.ts.
--
-- 0723 and 0755 are never edited (D#94 R1). The privilege bracket is copied from 0755 (and 0647: D#81/#92).
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

ALTER TABLE plan_imports DROP CONSTRAINT plan_imports_error_code_check;
ALTER TABLE plan_imports
  ADD CONSTRAINT plan_imports_error_code_check CHECK (error_code IN (
    'repo_not_connected', 'app_permission_missing', 'discussions_disabled', 'plan_file_inconsistent',
    'plan_file_too_large', 'token_not_read_only', 'github_unavailable', 'rate_limited_by_github',
    'request_budget_exhausted', 'plan_source_too_large', 'plan_file_missing', 'plan_file_shape', 'interrupted',
    'internal_error'));

-- Close the window opened above, matching 0755's own shape.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
