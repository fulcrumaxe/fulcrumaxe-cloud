# @fulcrumaxe/fx-runner

The local runner: the program that runs an agent on a customer's own machine for the fulcrumaxe cloud. This first
slice holds the parts that decide what an agent run may start with. The engine that starts the agent, the sandbox and
the daemon come in later changes.

- `src/job/verifyHashes.ts`: checks a job's task prompt, role card and tool list against the digests the cloud signed.
  A mismatch refuses the job before a workspace or process exists.
- `src/job/roleTools.ts`: the tool table, one entry per runner-eligible role. It never grants web fetch, web search or
  a platform MCP tool, and an unknown role is an error, never a default.
- `src/job/prompt.ts`: builds the text written to the agent's standard input. The task prompt is marked untrusted and
  is the last thing in it. Nothing in this package runs a string that came from a job.
- `src/job/cleanEnv.ts`: builds the agent's environment from a fixed list of names. The host environment is never
  copied as a whole, so an API key, a cloud token or a git token in your shell cannot reach the agent.
- `src/engines/claude/`: the engine that starts the agent CLI you have installed. It does not pin or hash the binary:
  it uses the absolute path stored when you ran setup. Before each job it checks that the binary at that path is at least
  the minimum supported version, that its `--help` lists every flag the engine passes, and (by asking the binary) that a
  login of the right kind exists. It then spawns the binary itself (no shell, an explicit argument list, the clean
  environment as its whole environment, its own process group so that a stop ends everything the agent started) with the
  prompt on standard input. It refuses a run id that is not a uuid and a sandbox block that is not switched on, checks
  where the binary says its credential came from before it processes any output, keeps the raw stream only in
  `~/.fx-runner/logs/<run>.jsonl` (0600, credential values removed) and reports metadata-only events.

## The daemon's parts

`src/daemon/` is what a runner does between claiming a run and reporting it done. Nothing starts on its own yet: a later
change wires it to the command line and the pinned job-signing keys. It only calls out (no listening socket).

- `client.ts`: signed `claim`, `heartbeat`, `events` and `done` calls. Requests are built with the protocol's message
  schemas and replies read with its reply schemas; anything else is an error with a closed code.
- `verifyJob.ts`: the one gate for a claimed job. A job that is not private, not signed by a pinned key, expired, tampered,
  or whose prompt, role card or tool list does not match its digest is refused before anything exists on this machine.
- `runEnded.ts`: how a run the daemon refused or could not finish is reported, with one closed-code `run_ended` event on the
  events route: `job_refused` (with the refusal as its detail, `duplicate_job` for a repeat), `repo_not_private`,
  `agent_failed`, `wall_clock`, `runner_setup` (with the setup failure as its detail, `other` for a code it does not know)
  and `runner_shutdown`. It is tried up to three times while the lease holds; a stop from the cloud, a lost lease, a crash or
  a `done` that was never confirmed send nothing, and the lease running out stays the fallback. A credential mismatch is
  never reported this way. The daemon's shutdown report is one attempt of five seconds at most.
- `ledger.ts`: a 0600 file of the job ids this machine has started, each kept until its own job's expiry; a job id seen
  before is not run again, also after a restart. A file that is damaged (anything but missing) is moved aside and the
  ledger refuses every job until a valid file is back at the path; a restart does not reopen it. One process holds the
  ledger at a time (a second one fails to start with `LedgerLockedError`); `close()` releases it.
- `lease.ts`: a heartbeat every 30 seconds and the run's metadata events in batches. A stop from the cloud, or a lease that
  could not be kept for 90 seconds, aborts the run. A batch the cloud has part of is trimmed and resent.
- `jobHandler.ts`: verify, hold the lease, run, then send `done` (retried a bounded number of times when the cloud cannot
  reach GitHub) with the engine's session id, and write the local session index.
- `pollLoop.ts`: the claim loop: waits the `retry_after` the cloud gives, backs off on errors, stops on SIGTERM or SIGINT.

## Command line

`bin/fx-runner.mjs` is the entry point; it looks up `HOME` and `FX_RUNNER_HOME` by name and hands everything else to
`runCli` in `src/cli.ts`. It runs from a build of `src/` (the installer comes later), not from the TypeScript directly.

- `fx-runner register --code <code> --credential-mode subscription|api_key --cloud-url <url>`: makes an Ed25519 key on
  this machine and registers it. The code comes from the workspace, works once and expires after 10 minutes. The request
  carries the code and the public key only. The private key is saved at mode 0600 in `~/.fx-runner` (mode 0700), next to
  `registration.json`, which holds no secret. A machine holds one registration; a second one is refused until the first
  is revoked (`fx-runner revoke`, or `fx-runner revoke --local` when the cloud no longer accepts the key), so one Claude
  login is never shared between accounts. A lock file (`register.lock`) keeps two `register` runs from both registering.
  The cloud's reply carries the account and the credential mode it stored for the code; `register` saves nothing unless that
  mode equals `--credential-mode`. On a mismatch it revokes the runner it just made (signed with the key it still holds in
  memory), writes nothing and exits non-zero.
- `fx-runner status`: shows the saved registration and the key's age. It makes no network call.
- `fx-runner revoke [--reason <text>] [--local]`: revokes this runner in the cloud with its own signature, then deletes
  the key and the registration. `--local` only deletes the local files, for a machine the cloud no longer accepts.

`FX_RUNNER_HOME` moves the state directory. A key over 90 days old is refused by the cloud: revoke and register again.

## Boundaries

No `@anthropic-ai/*` package is a dependency or an import. `test/` checks that, that no host-side tool is defined, that
no code spreads or loops over the process environment, and that no file names the places a Claude login is stored.

## Node

The supported minimum is Node 22.22.2 (`engines.node`). The repository builds and tests on Node 24, and CI also runs
this package's tests under Node 22.

## Licence

Source-visible and proprietary, the same licence as the rest of this repository: copyright Formal Hosting LLC, all
rights reserved, with no grant beyond what GitHub's Terms of Service give for viewing and forking on github.com. The
`LICENSE` file in this directory is identical to the one at the repository root.
