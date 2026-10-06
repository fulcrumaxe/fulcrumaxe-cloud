-- D#2 RLR-1: a source-line key on agent.output rows, so a replayed line cannot write a second row.
--
-- source_line is the record file's line number (its seq) that an agent.output row came from. The reader writes the
-- row with ON CONFLICT DO NOTHING, so a reader that re-reads after a crash, or a zombie that lost its lease, drops
-- into the key instead of duplicating output. Only agent.output rows carry it; every other row keeps NULL, and the
-- partial index ignores them. No new grant: table-level privileges on run_events already cover the column as they
-- cover the others, and the column-scoped readers (platform_ops, metering_reporter) do not get it.
ALTER TABLE run_events ADD COLUMN source_line bigint NULL;

CREATE UNIQUE INDEX run_events_agent_output_source_line
  ON run_events (run_id, source_line)
  WHERE kind = 'agent.output' AND source_line IS NOT NULL;

-- Only the runner login may write a source_line. Without this guard any app_user login could insert an
-- agent.output row with a chosen line, and the reader's real row for that line would be dropped by the key.
-- The check is on membership of agent_run_writer, the role the runner login holds.
CREATE FUNCTION run_events_source_line_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.source_line IS NOT NULL AND NOT pg_has_role(current_user, 'agent_run_writer', 'MEMBER') THEN
    RAISE EXCEPTION 'run_events.source_line is written only by the runner login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER run_events_source_line_guard BEFORE INSERT ON run_events
  FOR EACH ROW EXECUTE FUNCTION run_events_source_line_guard();
