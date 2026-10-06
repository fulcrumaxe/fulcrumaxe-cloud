-- D#71 DS-2d (correction C8): two columns and two partial unique indexes
-- for packages/discussions.
--
-- 1. discussion_comments.system_signed marks ONLY the rows that the
--    system-only postAgentComment writes (a panel seat's signed comment).
--    It is not an index on author_kind = 'agent': a run principal's own
--    comments are also author_kind = 'agent', up to twenty per run on its
--    thread, and those must stay unconstrained. The partial unique index
--    allows one signed row per (discussion, run) and is what makes a
--    replayed or concurrent postAgentComment a no-op.
-- 2. discussions.source_event_id is an opaque upstream event key that only
--    the system principal may set. The partial unique index allows one
--    discussion per (account, source event), so a replayed intake event
--    cannot create a second discussion.
--
-- No grant or RLS change. app_user already holds table-level INSERT on both
-- tables, which covers the new columns, and the column-level UPDATE grants
-- from 0618 are left as they were, so neither column can change after
-- insert. Neither column holds user text, so discussion_eraser is untouched.

ALTER TABLE discussion_comments
  ADD COLUMN system_signed boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT discussion_comments_system_signed_agent
    CHECK (NOT system_signed OR author_kind = 'agent');

CREATE UNIQUE INDEX discussion_comments_signed_once
  ON discussion_comments (discussion_id, agent_run_id)
  WHERE system_signed;

ALTER TABLE discussions
  ADD COLUMN source_event_id text,
  ADD CONSTRAINT discussions_source_event_id_length
    CHECK (source_event_id IS NULL OR char_length(source_event_id) BETWEEN 1 AND 200);

CREATE UNIQUE INDEX discussions_source_event_once
  ON discussions (account_id, source_event_id)
  WHERE source_event_id IS NOT NULL;
