-- D#600 CX-3a: the cache of a repository's map (the file tree summary the executor's prompt carries), built outside the sandbox.
--
--   repo_context_maps  at most ONE row per repository: the latest map, keyed by the commit it was built for (commit_sha: the default branch head the run starts from; the tree it names is what the map lists) and the map
--                      format (map_version). A build for another commit overwrites it, so "keep only the latest per repo" is the primary
--                      key, not a cleanup job. body is the map text, capped at 8192 bytes by a CHECK; body_sha256 is its hash.
--
-- Why a table: a Vercel function keeps nothing between calls, and two runs at one commit must make one trees call.
--
-- Disconnect: the row goes with the repository (ON DELETE CASCADE). A repository that is only DETACHED from its installation keeps its
-- row, but the read below answers nothing for it (the cache is read through the repository's current installation_id), so a detached
-- repository never gets a map out of the cache and a re-attached one is rebuilt at its next commit.
--
-- Access: app_user only, with row security forced, by the same tenant rule as the other per-account tables. The map is derived data
-- the platform can rebuild, so there is no definer: the writer is the build step, running in the account's own session. platform_ops
-- gets nothing. Nothing here is stamped from anything else: delete the row and the next run rebuilds it.
--
-- Numbered 0807 (reserved for this PR). Re-check against main right before merging.

CREATE TABLE repo_context_maps (
  account_id   uuid NOT NULL,
  repo_id      uuid NOT NULL,
  commit_sha     text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  map_version  text NOT NULL CHECK (map_version ~ '^[0-9]{1,4}$'),
  body         text NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 8192),
  body_sha256  text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  built_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, repo_id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE
);

ALTER TABLE repo_context_maps ENABLE ROW LEVEL SECURITY;
ALTER TABLE repo_context_maps FORCE ROW LEVEL SECURITY;

GRANT SELECT (account_id, repo_id, commit_sha, map_version, body, body_sha256, built_at) ON repo_context_maps TO app_user;
GRANT INSERT (account_id, repo_id, commit_sha, map_version, body, body_sha256, built_at) ON repo_context_maps TO app_user;
GRANT UPDATE (commit_sha, map_version, body, body_sha256, built_at) ON repo_context_maps TO app_user;
GRANT DELETE ON repo_context_maps TO app_user;

CREATE POLICY tenant_isolation_select ON repo_context_maps FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
CREATE POLICY tenant_isolation_insert ON repo_context_maps FOR INSERT TO app_user
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
CREATE POLICY tenant_isolation_update ON repo_context_maps FOR UPDATE TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
CREATE POLICY tenant_isolation_delete ON repo_context_maps FOR DELETE TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
