-- ENGINE-IN-CLOUD follow-up: look up the answers to one ask directly.
--
-- What: a partial index on engine_commands for "the answers to ask X in repo R of account A" (the engine command list's `ask_id` filter). Only
-- answer_ask rows are indexed, so the index stays small however many other commands a repo issues. Reading by ask replaces reading the latest
-- fifty commands and guessing, which locked new asks in a busy repo and depended on clock order.
--
-- No function, table, policy or grant is added, so there is nothing to revoke; reads still go through the table's RLS policies.
--
-- Why a separate migration and not part of 1029: 1029 is in review and about to merge; changing it would put an approved file back under review. The
-- table is new and empty when this runs, so the build is instant.
--
-- Rollback (expand/contract): dropping the index only makes the filtered list slower, nothing depends on it for correctness.

CREATE INDEX engine_commands_ask_idx ON engine_commands (account_id, repo_id, (args ->> 'ask_id')) WHERE kind = 'answer_ask';
