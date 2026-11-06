-- D#483: say on the Inbox card when a proposal came from one of our own agent runs.
--
-- An issue opened by this platform's GitHub App (its `<slug>[bot]` login) can only have come from a sandbox agent run, so it stays a proposal a
-- person approves; the person reading it should know that. `proposals.origin` records it when the webhook turns such an issue into a proposal:
--   'agent_run'  the issue's author is one of the platform App's own bot logins
--   'other'      everything else (the default; a person, another bot, or an author we could not check -- the check fails closed to this)
-- It is a label for the reader and nothing more: trust, verification, the owner process and the start gate read provenance, state and the
-- verification columns exactly as before and never read this one.
--
-- Only plan_importer (the role that creates proposals) may write it, and only at INSERT: no UPDATE grant is given, so a later import, an edit of
-- the issue or a verification never changes it. app_user already reads the table. Expand-only: a NOT NULL column with a constant default, so the
-- previous deploy keeps running on this schema. Numbered above the highest on the code plane (0998) and the number open work holds (0999); re-checked right before merge.
ALTER TABLE proposals
  ADD COLUMN origin text NOT NULL DEFAULT 'other'
    CONSTRAINT proposals_origin_check CHECK (origin IN ('other', 'agent_run'));
GRANT INSERT (origin) ON proposals TO plan_importer;
