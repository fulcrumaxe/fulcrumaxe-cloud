# @fx/sitekit-claims

Claim schema and the render-refuses-unverified gate for site kit (D#2606 K01).

Pure TypeScript, no fs/network/model imports (enforced by `test/purity.test.ts`).
`gateSite` decides which claims a site is allowed to render; `assertRenderable`
is the per-claim rule it's built on.

## Install

```
pnpm install
```

This package carries its own `pnpm-workspace.yaml` (with `allowBuilds: { esbuild: true }`,
needed by vitest) and its own lockfile, so a plain `pnpm install` from this
directory is self-contained — it does not need `--ignore-workspace`, and it
won't stop to prompt for build-script approval. Keep both files as-is at
least through D#2606 I1 (root workspace integration); once this package
joins a real pnpm workspace, `allowBuilds` moves to the workspace root and
this file goes away.

## Scripts

- `pnpm test` — vitest
- `pnpm run typecheck` — `tsc --noEmit`
- `pnpm run build` — `tsc`, emits `dist/`
