# apps/live-e2e

Live end-to-end packs that will run against the deployed app: staging now,
a read-only production smoke after launch. This first slice holds only the
parts that need no browser and no credentials: the pack manifest, selection,
the targets with the production guard, the env-only needs, and the `plan`
command. Nothing here starts Chromium or touches the network.

Sources:
- `apps/live-e2e/src/manifest.ts`
- `apps/live-e2e/src/select.ts`
- `apps/live-e2e/src/targets.ts`
- `apps/live-e2e/src/needs.ts`
- `apps/live-e2e/src/plan.ts`
- `apps/live-e2e/src/cli.ts`
- `apps/live-e2e/targets/staging.json`
- `apps/live-e2e/targets/production.json`
- `apps/live-e2e/packs/platform/pack.json`
- `apps/live-e2e/packs/auth-negative/pack.json`

## Using it

```
pnpm --filter live-e2e exec live-e2e plan --target staging --tier smoke
```

writes `plan.json` (ignored by git) and prints one line per selected pack:
`RUN`, `SKIPPED-NEED <need>` (green, listed) or `REFUSED <reason>`. A refusal
of a pack named with `--pack` exits non-zero; an empty selection exits
non-zero with `EMPTY-SELECTION`.

## Rules the code enforces

- A pack's `pack.json` has a closed set of keys and a closed set of needs.
  A `@ui` pack must list all three device projects; `model_spend` is allowed
  only on tier `full`.
- Selection is a union of the tier, the named packs and (later) changed-file
  routing, narrowed by `--tag`. A model-spending pack runs only for the
  `dispatch` and `weekly` triggers.
- A target file carries no destructive switch; its loader rejects any key
  outside the schema. On the production target the runner refuses every
  destructive pack and every pack that does not list production (layer 1, in
  `targets.ts`). There is no `--force`.
- A target file names, rather than holds, its deployment origin and Vercel project id (`origin_env`, `project_id_env`). The loader reads those variables when the target is selected (`LIVE_E2E_STAGING_ORIGIN` and `LIVE_E2E_STAGING_PROJECT_ID` for staging; the `PRODUCTION` pair for production) and refuses, naming the variable, if one is unset. There is no default host.
- Env-only needs: `bypass` (the target is protected and the bypass secret is
  present), `stripe-test` (a restricted test-mode key, never a live one) and
  `host-capacity` (load under 18 and at least 4 GiB available). A need that
  needs the network is not evaluated yet and counts as unmet.

Later tasks add the report and scrub code, changed-files routing, the
Playwright config, the `run` command and the packs' specs.
