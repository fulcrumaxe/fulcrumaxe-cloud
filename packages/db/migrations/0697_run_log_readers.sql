-- D#2 RLR-1: the run-log reader's lease and cursor (design: Round 3 of the run-log-reader design, sections B3 and B6).
--
-- One row per run. It says which command's record file is being read, how far it has been read and committed
-- (next_seq, byte_offset), the bounded state snapshot at that point (state, side_effects), and who may read now:
-- a fencing lease. epoch counts takeovers; a taker raises it, and every later write is checked against the epoch it
-- took, so a reader that lost the lease cannot move the cursor. The lease lasts 60 s and every commit renews it.
--
-- Who may touch it: the runner login only (a member of agent_run_writer, as in 0685), through a policy that also
-- pins the row to the caller's tenant. app_user, platform_ops, partner_user and PUBLIC hold nothing on the table.
-- The runner may insert the identity columns (the rest start at their defaults: epoch 0, lease expired) and may
-- update the cursor, state and lease columns only; the identity columns are fixed after insert.
-- The runner login is created by ops and holds agent_run_writer already; this file adds no role.
CREATE TABLE run_log_readers (
  run_id        uuid PRIMARY KEY,
  account_id    uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  cmd_id        text NOT NULL CHECK (length(cmd_id) BETWEEN 1 AND 128),
  -- The record file is /fx/run/<run id>.rec and nothing else (the run id is server-made, never the VM's).
  record_path   text NOT NULL,
  next_seq      bigint NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
  byte_offset   bigint NOT NULL DEFAULT 0 CHECK (byte_offset >= 0),
  state         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(state) = 'object' AND octet_length(state::text) <= 262144),
  side_effects  jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(side_effects) = 'object' AND octet_length(side_effects::text) <= 4096),
  epoch         bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  lease_until   timestamptz NOT NULL DEFAULT clock_timestamp(),
  read_failures integer NOT NULL DEFAULT 0 CHECK (read_failures >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_log_readers_record_path CHECK (record_path = '/fx/run/' || run_id::text || '.rec'),
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id) ON DELETE CASCADE
);

ALTER TABLE run_log_readers ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_log_readers FORCE ROW LEVEL SECURITY;
REVOKE ALL ON run_log_readers FROM PUBLIC, app_user;

-- Column grants only, no table-level privilege: agent_run_writer holds no table privilege anywhere (0642's
-- contract, kept by a test), and a column added later gets no grant until someone writes one.
GRANT SELECT (run_id, account_id, cmd_id, record_path, next_seq, byte_offset, state, side_effects, epoch,
              lease_until, read_failures, created_at, updated_at)
  ON run_log_readers TO agent_run_writer;
GRANT INSERT (run_id, account_id, cmd_id, record_path) ON run_log_readers TO agent_run_writer;
GRANT UPDATE (next_seq, byte_offset, state, side_effects, epoch, lease_until, read_failures, updated_at)
  ON run_log_readers TO agent_run_writer;

CREATE POLICY runner_tenant ON run_log_readers FOR ALL TO agent_run_writer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
