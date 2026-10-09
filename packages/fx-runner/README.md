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

`src/daemon/` is what a runner does between claiming a run and reporting it done. `fx-runner run` (below) wires it together.
It only calls out (no listening socket).

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

`bin/fx-runner.mjs` is the entry point; it looks up `HOME`, `FX_RUNNER_HOME`, `FX_RUNNER_PROTECTION_BYPASS_FILE` and `XDG_CACHE_HOME` by name and hands everything else to
`runCli` in `src/cli.ts`. It runs from a build of `src/`, not from the TypeScript directly: see "Build from source".

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

- `fx-runner run`: claims and runs jobs until you stop it (Ctrl-C or SIGTERM, which stops the job in hand within seconds and
  reports `runner_shutdown`). It checks, before its first claim, that this machine is registered, that this build pins
  job-signing keys for the cloud it registered with (`src/keyring.ts`; the keys are committed in the build, and no file,
  variable or option adds or replaces one, so an address with none, such as production before its key exists, is refused as
  `job_keyring_missing`), that the sandbox tools and the agent CLI are found (the CLI is looked up once, here), that the repo
  mirrors directory (`~/.cache/fx-runner/mirrors`) does not overlap the state directory or the other runner directories, and
  that the job ledger (`jobs.ledger` in the state directory) is not damaged. One `run` holds the state directory at a time.
  At start it removes the temporary files a crash left next to the ledger, but only exact-name regular files older than ten
  minutes. A registration for `api_key` mode is refused until a local key file is supported. Residual risk, accepted: if three
  runs start at once on a lock a crash left behind, two may both take it; there is no `flock`, and `service install` runs one
  instance per user.
- `fx-runner attach [<run | short id> | --latest] [--take-over]`: watch a job running on this machine, or take it over. With tmux
  installed, `run` makes one tmux session per job (`fx-<short id>`) on a private socket (`<state dir>/tmux/`, directory 0700,
  socket 0600, inside the sandbox's deny lists). The agent is never started by tmux: the pane only renders the job's local
  transcript, so a tmux crash cannot touch the job, and the tmux server starts with an environment of four names (no credential).
  With no argument `attach` lists the running jobs; with a job it attaches read-only (`tmux attach-session -r`). `--take-over`
  asks you to type the job's short id, then the daemon sends the agent SIGINT, tells the cloud once that the run was taken over
  (a `taken_over` event, then `done` with no result, so the cloud ends it `failed` with reason `taken_over` and a review run
  never counts toward a merge gate), pushes nothing, and swaps the pane to the agent's own interactive resume (the job's
  settings and sandbox, `--permission-mode default`, so you approve each action). Commit and push with your own git. Only this
  OS user can attach, and no message in the runner protocol starts, attaches to or types into a session. Without tmux, jobs run
  unwatched.

- `fx-runner doctor`: one PASS, WARN or FAIL line per check, and a non-zero exit if any FAIL. It checks the registration and its
  key, that the cloud answers, that the Claude Code CLI is found (the same lookup `run` makes), that its version is at least the
  minimum the runner supports and that its `--help` lists every flag the runner passes, and whether a login of the right kind
  exists (yes, no or unknown, with the method label). It also runs a sandbox probe: one fixed test command inside the sandbox rules
  a job gets (bubblewrap on Linux, Seatbelt on macOS; no network, no model request). A failure carries one of five reason
  codes (`bwrap_missing`, `socat_missing`, `userns_disabled`, `apparmor_userns_restricted`, `probe_failed_other`) and the exact fix
  for your distro: Debian and Ubuntu, Fedora, Arch, NixOS (the configuration line, never `nix-env`), or a generic line. On Ubuntu
  with the AppArmor restriction on user namespaces it prints a profile that allows them for `bwrap` only, and the weaker
  machine-wide setting second. There is no unsandboxed fallback. In subscription mode it warns when `ANTHROPIC_API_KEY` or
  `ANTHROPIC_AUTH_TOKEN` is set in your shell, because it would outrank your Claude login; the runner removes it from jobs. It
  makes no model request and prints no secret: the shell variables are shown by name only, and of the CLI's answers only the
  version, the flag names and a short method label are kept.
- `fx-runner logs <run id>`: prints the local transcript of a run on this machine from `~/.fx-runner/logs/<run id>.jsonl`, the
  runner's own capture (never Claude Code's project logs). Agent text, the tools used (as the cloud sees them, without their
  input), results, and stderr notes are shown; credential values are removed when the file is written and the output is
  redacted again and stripped of control characters.
- `fx-runner service install | uninstall`: writes (or removes) the per-user file that keeps `fx-runner run` going: a systemd
  user unit (`~/.config/systemd/user/fx-runner.service`) on Linux, a launchd agent
  (`~/Library/LaunchAgents/dev.fulcrumaxe.fx-runner.plist`) on macOS. It only writes the file and prints the command that starts
  it; it starts nothing. There is one unit per user, so a second `install` rewrites the same file, and `run` itself refuses a
  second copy on the same state directory. A file at that path that `service` did not write is never overwritten or removed.
  The unit carries your shell's `PATH` (so it finds Claude Code) and, if you use `FX_RUNNER_HOME`, that too; a path with a
  space or another unusual character is refused.

## Build from source

`scripts/build-sea.mjs` builds the release program: one executable with Node inside it, for the platform it runs on.

    SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) node scripts/build-sea.mjs [--out-dir dist/sea]

It bundles `bin/fx-runner.mjs` and `src/**` into one CommonJS file with esbuild, downloads the pinned Node release
(`NODE_VERSION` in the script) and checks it against nodejs.org's `SHASUMS256.txt` and against the SHA-256 pinned in the
script, makes the single-executable blob with that Node, and injects it with postject (on macOS it removes the signature,
injects, signs ad hoc and verifies). It writes `fx-runner-<platform>` and `release-manifest.json` (version, platform,
SHA-256, size) to `--out-dir`, and writes nothing if any step fails. A target is built on a machine of the same platform.
Two builds of one commit with the same `SOURCE_DATE_EPOCH` are byte-identical. The release file names are the
`ARTIFACT_NAMES` constant in `scripts/release-manifest.mjs` (`node scripts/release-manifest.mjs --names` prints them).

## Supported platforms

| Platform | v1 |
|---|---|
| macOS arm64 and x64 | supported as a **preview, not yet verified** (see below) |
| Linux x64 and arm64 | supported |
| Native Windows | not supported |
| WSL2 | not supported |
| WSL1 | not supported |

macOS support is a preview, not yet verified: jobs run in Claude Code's own sandbox, which has not been proven on macOS yet.
`fx-runner doctor` repeats this on macOS. Native Windows, WSL1 and WSL2 are not supported in v1, so the runner refuses to start there (`windows_unsupported`, `wsl1_unsupported`, `wsl2_unsupported`). Windows support is planned. The runner prints: "fx-runner does not support Windows yet, including WSL2. Linux and macOS are supported."

There is one install path per OS: the installer script, which arrives with the release change, installs the macOS build on
macOS and the Linux build on Linux. Claude Code itself must already be installed and signed in.

`FX_RUNNER_HOME` moves the state directory. A key over 90 days old is refused by the cloud: revoke and register again.

### Reaching a protected staging cloud

For staging or a protected preview only; production needs no bypass. A cloud behind Vercel Deployment Protection answers every
runner call with Vercel's own 401 "Protected deployment". Put the project's "Protection Bypass for Automation" secret in a file and
name the file in `FX_RUNNER_PROTECTION_BYPASS_FILE`:

    mkdir -p -m 700 ~/.fx-runner && install -m 600 /dev/null ~/.fx-runner/bypass && printf '%s\n' '<the secret>' > ~/.fx-runner/bypass
    FX_RUNNER_PROTECTION_BYPASS_FILE=~/.fx-runner/bypass fx-runner run

- **Where the file must live.** Under your home directory; the state directory (`~/.fx-runner/`) is the place we recommend. A job's
  agent runs as your user, so file mode and owner do not hide the file from it. What does is the job sandbox, which denies reads of
  the home directory and of the state directory. So the file's real path (every link followed) must be inside your home directory
  and not inside a directory the sandbox re-allows for reads: the cache directory's `workspaces`, `tmp` and `mirrors`
  (`~/.cache/fx-runner/` on Linux, `~/Library/Caches/fx-runner/` on macOS, or under `XDG_CACHE_HOME` when that is set). A file
  anywhere else, for example in a system temp directory or a service directory outside home, is refused with `bypass_file_location`.
- The file must be a plain file (not a link), owned by you, mode 0600 or stricter, holding one value of printable characters
  without spaces. Anything else stops `register`, `revoke` and `run` before a request, with a closed code
  (`bypass_file_unreadable`, `bypass_file_not_regular`, `bypass_file_not_owned`, `bypass_file_mode`, `bypass_file_invalid`, and `bypass_file_location` for the rule above).
- The value is sent as the `x-vercel-protection-bypass` header on every runner call to the registered cloud address (same scheme,
  host and port), and nowhere else: not to GitHub, not to the git proxy, not to any other host. A redirect from the cloud is
  not followed. It is never printed, logged, put in an argument list or written into `registration.json`.
- `fx-runner doctor` prints `Protection bypass: set (file ok)` or `not set`, never the value. If the cloud answers with Vercel's
  protected-deployment 401, doctor says so and names the variable.
- `fx-runner service install` carries the variable into the systemd or launchd unit the same way it carries `FX_RUNNER_HOME`: the
  unit holds the path of the file, never the secret. The path must be absolute and plain (letters, digits and `_ . / @ + = -`), and
  install does not open the file. Run `service install` again after you change the variable; with it unset, the rewritten unit
  has no such line.
- Vercel's protection answer is recognised by a 401 whose JSON body says `protection.vercel_auth_enabled` is true or whose
  `error.message` is "Protected deployment". The cloud's own refusals (for example `runner_revoked`) are never taken for it.

## Updates (the TUF client)

`src/update/tuf.ts` is the client that checks a release before anything installs it. It uses `tuf-js` (exact version in the
lockfile) and writes no cryptography of its own. It verifies root rotation, the signature threshold of every role, expiry,
that no metadata version goes back, the snapshot's hashes, and each release file's length and SHA-256. Any failure is a
refusal that names its class, never an exception, and a failed download leaves no file. It stages nothing: a verified file is
handed back in a private directory under `<state dir>/tuf/`.

- The first root, the metadata location and the target location are build constants (`src/update/buildConfig.ts`). Nothing
  read at run time can replace them. No root ships yet, so a build says "updates are not configured in this build",
  `fx-runner doctor` says so on its `Updates` line, and the updater makes no network call.
- The only network code is `src/update/pinnedFetcher.ts`: `https:` only, only under the two configured locations, and a
  release redirect to another origin (GitHub's real behaviour) is followed by hand, up to 5 hops, refusing any hop that is not
  `https:` before it connects.
- Expired release metadata pauses updates ("updates paused: release metadata expired on YYYY-MM-DD"). Jobs are never
  affected.
- Tests use the real client against metadata built with the reference model classes and signed with throwaway keys, served
  from a local HTTPS server (`test/fixtures/`). No real key or root is committed.

### Applying updates (`fx-runner update`, `fx-runner config`)

`src/update/updater.ts` is the only code that installs what the TUF client verified. The layout is the one `install.sh` makes:
`<state dir>/versions/<v>/fx-runner` and a relative link `<state dir>/bin/fx-runner` to the version in use. The service unit
runs the link, so a switch takes effect at the next start.

- `update --check` shows the current and the available version. `--pin <v>` holds a version and installs it now (an explicit
  pin may go down). `--unpin`. `--rollback` returns to the one kept previous version. `config set auto-update on|off`.
- The daemon checks at most every 6 hours, only at the top of the claim loop (no job in hand), and never when automatic updates
  are off, a version is pinned, the build has no root or the install is Homebrew's. It never goes to an older version by itself.
- An update is staged in a private directory, hashed again, moved to `versions/<v>/`, asked to start (`--version`, then
  `doctor --sandbox-only`), and only then does the link change, by renaming a new link over the old one. If the program fails
  the same check through the link, the link goes back and that version is skipped from then on. Any error leaves the current
  version in use. Nothing is overwritten in place, so a running job keeps the file it started from.
- Under the service unit (`FX_RUNNER_SERVICE=1`) `run` exits with 75 after a switch so systemd or launchd starts it on the new
  version; in the foreground it prints "Updated to {v}. Restart `fx-runner run` to use it." and goes on.
- A crash between staging and switching leaves the old version in use; the next `run` removes the partial directory.
- A Homebrew install (or a program that does not start out of `versions/`) never self-replaces: `--check` prints
  "A newer version is available: run brew upgrade fx-runner".
- `doctor` has an `Updates` line: the version, pinned or not, automatic updates on or off, the last check, and "updates paused:
  {reason}" when they are.

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
