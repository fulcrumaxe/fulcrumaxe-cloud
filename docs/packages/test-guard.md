# test-guard

`@fx/test-guard` is a Vitest setup file, wired into every workspace project, that blocks a test from accidentally calling a real model endpoint or spawning a `claude` binary while `FX_FORBID_MODEL_CALLS=1` is set — turning an accidental live-model call in a test suite into an immediate thrown error instead of real token spend.

Sources:
- `packages/test-guard/src/`
- `packages/test-guard/test/`
- `packages/test-guard/package.json`
- `vitest.workspace.ts`

## What it does

`installModelCallGuard` (`packages/test-guard/src/guard.ts`) is a no-op unless `env.FX_FORBID_MODEL_CALLS === "1"`. When it is set, the guard patches `globalThis.fetch` to throw `ModelCallBlockedError` for any request whose host is `ai-gateway.vercel.sh` or `api.anthropic.com` (`FORBIDDEN_MODEL_HOSTS`), and patches `node:child_process`'s internal `ChildProcess.prototype.spawn` — the shared internal that `spawn`/`exec`/`execFile`/`fork` all funnel through regardless of import style — to throw the same error class when the command or its arguments name a `claude`/`claude-code` binary. `packages/test-guard/src/setup.ts` is the actual Vitest `setupFiles` entry: it just calls `installModelCallGuard()` at import time with no arguments (reading `process.env` directly).

## Public surface

`packages/test-guard/src/guard.ts` (imported directly by other packages' `vitest.config.ts`, and by `packages/test-guard/src/setup.ts`) exports `installModelCallGuard`, `InstalledGuard`, `ModelCallBlockedError`, and `FORBIDDEN_MODEL_HOSTS`. `packages/test-guard/src/setup.ts` has no exports of its own — it is used only as a side-effecting Vitest `setupFiles` path.

## How it works

**Fetch interception.** `hostFromFetchInput` extracts a host from a string URL, a `URL` object, or a `Request`-shaped object's `.url` field, and the guard compares it against `FORBIDDEN_MODEL_HOSTS` exactly (no substring match). A host that fails to parse, or doesn't match, falls through to the real `fetch`.

**Process-spawn interception.** The guard reads `node:child_process` through `createRequire` rather than a static `import * as childProcess`, because Node's CJS/ESM interop gives a static namespace import a frozen object whose `spawn` property cannot be reassigned; going through `require` gets the real, mutable CommonJS exports object the guard needs to patch. It patches the `ChildProcess` prototype's own `spawn` method — not the individually exported `spawn`/`exec`/`execFile`/`fork` functions — because those are thin wrappers that all end up calling the same prototype method internally, so patching there catches every call style (`import * as cp`, a named import, or `require`) uniformly. `mentionsClaudeBinary` matches on the basename of a path-like command/argument (not the full path) specifically so an unrelated binary invoked from a directory that happens to contain "claude" somewhere in its path (for example a checkout under a `.claude/worktrees/...` directory) is not mistaken for the `claude` binary itself.

**Wiring into each vitest config.** `vitest.workspace.ts`'s own header comment states the rule: every project must add the guard's setup file to its own `setupFiles`. Concretely, `packages/runner/vitest.config.ts`, `packages/runtime/vitest.config.ts`, `packages/model-router/vitest.config.ts`, `packages/model-connection/vitest.config.ts`, `packages/roles/vitest.config.ts`, `packages/gh-policy/vitest.config.ts`, and `packages/trust/vitest.config.ts` each list `"../test-guard/src/setup.ts"` as the first entry in their own `setupFiles` array (several also add a second, package-specific setup file such as `bind-test-env.ts` for Postgres-backed suites). `vitest.workspace.ts` itself wires the guard into the `test-guard` project (which is `packages/test-guard` itself) and the `web` app inline. `packages/test-guard/test/workspace-coverage.test.ts` is what enforces this rule mechanically: it lists every `apps/*`/`packages/*` directory with its own `package.json`, confirms each is registered somewhere in `vitest.workspace.ts`, and confirms every registered project's config (inline block or its own `vitest.config.ts`) actually declares a `setupFiles` entry pointing at `test-guard/src/setup.ts` — including two deliberate-failure fixtures proving the check would catch a config missing that entry.

**Proving the guard fires.** `pnpm test:guard` (the root `package.json` script) runs exactly `vitest run packages/test-guard/test/guard-violation.fixture.test.ts` — the fixture that forces `FX_FORBID_MODEL_CALLS=1`, installs the guard, then performs exactly the actions the guard exists to stop (a `fetch` to each forbidden host, a `child_process.spawn`/`exec`/`execFile` of the `claude` binary) and asserts each one throws the guard's own error, plus two negative cases (an unrelated host, an unrelated binary) asserting the guard does *not* block them. If the guard is ever weakened or removed, this fixture goes red instead of a live-model call silently succeeding.

## Data it touches

None — this package only patches global `fetch` and `child_process` internals in the test process.

## Security notes

See `../security.md`. `FX_FORBID_MODEL_CALLS=1` is set by `scripts/check.sh`'s test step (`env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN FX_FORBID_MODEL_CALLS=1 pnpm test`) and by `.github/workflows/ci.yml`, so every automated test run — locally via `scripts/check.sh` and in CI — runs with the guard active; see `../operations.md` for how CI invokes it.

## Tests

Run with `pnpm test:guard` for the deliberate-violation fixture specifically, or as part of the full `pnpm test` (`vitest run`, driven by `vitest.workspace.ts`) which also runs `packages/test-guard/test/workspace-coverage.test.ts`. `package.json`'s own `test` script is limited to `typecheck` (`tsc --noEmit`) — there is no package-local `test` script; both test files run through the root workspace invocation instead.
