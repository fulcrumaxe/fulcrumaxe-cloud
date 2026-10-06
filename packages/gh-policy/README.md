# @fx/gh-policy

Pure decision engine for the GitHub proxy. `decide()` takes one normalized
request (method, host/SNI, path, role, product, installation, optional
parsed git ref updates or label names) and returns an allow/deny verdict
plus the token scope to mint. No network, no filesystem, no `fetch` —
enforced by `test/importScan.test.ts`.

- `decide(req)` — the policy decision.
- `parseReceivePackRefUpdates(body)` — parses the ref-update commands out
  of a `git-receive-pack` pkt-line request body.
- `ROLE_PERMISSIONS` — the per-role minimum GitHub App permission table for
  the `team` product (pinned by a test; widen it and the diff shows in
  review).

## Trust boundary for the caller (H13's proxy function)

`decide()` is pure — it never parses an HTTP body itself. `ProxyRequest.gitRefUpdates`,
`.labelNames` and `.patchFields` are the only account it has of what a request's body
contains, and every guarantee this package makes (label ownership, patch-field
allowlists, fx/* push scoping) is proved *assuming* that account is honest and complete.
The caller is what makes that true, and it must:

1. Derive each of those three fields from the **exact** parsed body (pkt-line for
   `gitRefUpdates`, JSON for the other two) of the **same** request being decided.
2. **Deny outright** when a body is missing, fails to parse, or parses to the wrong
   shape (JSON that isn't an object, say) — never substitute "no fields" or "an empty
   array" for "I couldn't read it." A `decide()` call that can't see a `labels` field
   is not evidence the body has none.
3. Forward the **byte-identical** body to GitHub if the call is allowed. Parsing one
   body to build `patchFields` and then forwarding a re-serialized or otherwise
   different one makes `decide()`'s approval an approval of a request that was never
   actually sent — the body-level version of what `canonicalPath.ts` exists to prevent
   at the URL-path level.

See the module docstring in `src/types.ts` for the same guarantee aimed at code inside
this package.

## Running the tests

```sh
pnpm install
pnpm test              # or: pnpm test:coverage
pnpm typecheck
```

Plain `pnpm install` (no `--ignore-workspace`) is what actually works today:
this package ships its own single-package `pnpm-workspace.yaml` so it's a
self-contained pnpm project, and that file is also where `esbuild`'s
postinstall gets approved (`allowBuilds: esbuild: true` — pnpm 11's
supply-chain gate otherwise blocks it, and vitest needs esbuild's platform
binary to run at all).

`pnpm install --ignore-workspace` was the documented invocation for wave-1
packages before any root `pnpm-workspace.yaml` exists, so a package can't
accidentally bind to an ancestor workspace. In this pnpm version (11.27),
`--ignore-workspace` also disables reading of *every* workspace-manifest
setting, `allowBuilds` included, with no `.npmrc`-level equivalent — so
`--ignore-workspace` on a clean checkout fails on `ERR_PNPM_IGNORED_BUILDS`
before vitest ever runs (confirmed empirically, not a code defect here).
Plain `pnpm install` from this directory finds this package's own
`pnpm-workspace.yaml` (there is no ancestor one yet) and works cleanly end
to end. When I1 folds this package into the root workspace, this file
should be removed in favor of the root one and `esbuild` added to the
root's own build-approval list.
