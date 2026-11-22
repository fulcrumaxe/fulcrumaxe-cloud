-- D#845 MC-4: the key a create request carries, kept on the row it made.
--
-- A person's double click, a retry after a lost answer and a second tab all send the same Idempotency-Key. The create flow looks the key up before it
-- touches Hetzner and answers the existing row, so one key makes one server. This unique index is the backstop under that lookup: two requests that both
-- got past it cannot both insert, whatever the code does. The key is per account (the index leads with account_id), so another account's key never meets this one.
--
-- The column is written once, by the INSERT (app_user's INSERT on managed_servers is table-wide, 1035). Its UPDATE grant is a column list that does not
-- name it, so it never changes afterwards. Rows made before this migration have none (NULL, and the partial index skips them).
-- Numbered 1054: re-check against main right before merging and renumber to stay above its highest.

ALTER TABLE managed_servers
  ADD COLUMN idempotency_key text CHECK (idempotency_key ~ '^[ -~]{1,255}$');

CREATE UNIQUE INDEX managed_servers_idempotency_key ON managed_servers (account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
