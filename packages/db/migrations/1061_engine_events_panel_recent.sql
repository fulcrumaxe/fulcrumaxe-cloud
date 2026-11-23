-- D#845 ON-25a: each Team panel's "as of" is the newest event that panel reads, so the per-repo read asks for the newest `received_at` per session and kind.
-- That is one backward probe of this index per session and kind, however many events a session holds (the primary key alone is ordered by seq, not by kind).
-- No table, grant, policy or function changes: the index only speeds a read, and dropping it later changes no answer.
--
-- Numbered 1061 by the Team Lead (pre-claimed). Re-check against main right before merging.

CREATE INDEX engine_events_panel_recent ON engine_events (session_id, kind, received_at DESC);
