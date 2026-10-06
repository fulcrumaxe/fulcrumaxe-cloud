-- D#483 P3 (owner ruling): the debater is OFF by default. 0687 seeded every existing repo's debater row as
-- 'feature_critical'. Turn the rows that are still exactly as seeded to 'off'.
--
-- Seeded versus changed by a person: every write through the role-settings service sets updated_at = now(), and a row
-- 0687 (or repo creation) inserted has updated_at = created_at (both the insert transaction's now()). A row whose
-- updated_at differs from created_at was written after it was seeded (a person chose that mode, even the same one), and
-- is not touched. A debater row that is 'always', 'off' or already changed stays as it is.
UPDATE role_settings
   SET mode = 'off'
 WHERE role = 'debater'
   AND mode = 'feature_critical'
   AND updated_at = created_at;
