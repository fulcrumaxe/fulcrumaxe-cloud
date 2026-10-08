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

## Command line

`bin/fx-runner.mjs` is the entry point; it looks up `HOME` and `FX_RUNNER_HOME` by name and hands everything else to
`runCli` in `src/cli.ts`. It runs from a build of `src/` (the installer comes later), not from the TypeScript directly.

- `fx-runner register --code <code> --credential-mode subscription|api_key --cloud-url <url>`: makes an Ed25519 key on
  this machine and registers it. The code comes from the workspace, works once and expires after 10 minutes. The request
  carries the code and the public key only. The private key is saved at mode 0600 in `~/.fx-runner` (mode 0700), next to
  `registration.json`, which holds no secret. A machine holds one registration; a second one is refused until the first
  is revoked (`fx-runner revoke`, or `fx-runner revoke --local` when the cloud no longer accepts the key), so one Claude
  login is never shared between accounts. A lock file (`register.lock`) keeps two `register` runs from both registering.
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
