# model-router

`@fx/model-router` decides which model tier a given role/work-item-size pair runs on: a data-driven routing table read from Postgres, a customer override with a hard security floor, one-tier escalation on failure, and the offline evaluation script that bootstraps the table's initial values.

Sources:
- `packages/model-router/src/`
- `packages/model-router/eval/bootstrap.ts`
- `packages/model-router/test/`
- `packages/model-router/package.json`

## What it does

`route(input, table)` (`packages/model-router/src/route.ts`) is a pure, synchronous function: given a `{ role, size, repoSettings? }` input and a `RoutingTable`, it looks up the matching `(role, size)` row, applies a customer `modelOverride` if present and not below the role's floor, then clamps the result to the role's floor regardless of what the table or the override said. `loadLiveRoutingTable(pool)` reads the one `routing_tables` row with `status = 'live'` and its `routing_rows`, validating every row before returning it. `routeForRun(pool, input)` is the convenience wrapper that loads the live table and routes in one call.

`escalate(previousRun)` (`packages/model-router/src/escalate.ts`) moves a role up exactly one tier — Haiku 4.5 → Sonnet 5 → Opus 5, capped at Opus 5 — when the previous run's outcome was a review `needs-fix` verdict, a `fail` status, or a `timed_out` status; a `killed_spend` outcome, or any non-failing outcome, does not escalate. `floors.ts` defines `ROLE_FLOORS`: only `security-reviewer` and `security-expert` have a floor today, pinned to `sonnet-5`, enforced identically by `route`, `escalate`, `applyCustomerOverride`, and table validation so none of those four paths can be used to run a floored role below its floor.

`proposal.ts` computes a new candidate table from historical run outcomes (`aggregateByPair`, `buildProposal`, keeping a `(role, size)` pair's current model when it has fewer than 20 observed runs), decides whether to promote it (`decidePromotion`, comparing weighted success rates), and persists both steps (`saveProposedTable`, `applyPromotionDecision`) as `routing_tables`/`routing_rows` rows with `status` values of `proposed`, `live`, `retired`, or `rejected`.

## Public surface

Everything `packages/model-router/src/index.ts` re-exports: `types.ts` (`ModelId`, `Size`, `RoutingRow`, `RoutingTable`, `RepoSettings`, `RouteInput`, `RouteResult`, `MODEL_TIER_ORDER`, `tierRank`), `roleUniverse.ts` (`ALL_ROUTABLE_ROLES`, `SITE_KIT_ROLES`), `floors.ts` (`ROLE_FLOORS`, `floorFor`, `meetsFloor`, `assertRowMeetsFloor`, `applyCustomerOverride`, `OverrideResult`), `route.ts` (`route`, `loadLiveRoutingTable`, `routeForRun`), `escalate.ts` (`escalate`, `EscalationCause`, `PreviousRun`, `EscalationResult`), `tableSchema.ts` (`RoutingRowSchema`, `DefaultTableFileSchema`, `validateRoutingRows`, `isKnownModelId`), and `proposal.ts` (`RunOutcomeSample`, `PairAggregate`, `aggregateByPair`, `buildProposal`, `PromotionDecision`, `decidePromotion`, `saveProposedTable`, `applyPromotionDecision`).

## How it works

`RoutingTable` is `{ version, rows: RoutingRow[] }`, one row per `(role, size)` pair where `size` is `"Small" | "Feature" | "Critical"`. `route` throws if no row matches the given `(role, size)`. `tierRank` indexes into `MODEL_TIER_ORDER` (`["haiku-4.5", "sonnet-5", "opus-5"]`) and returns `-1` for an unrecognized model id; `escalate` throws rather than silently treating an unrecognized previous model as the bottom tier, since `Math.min(-1 + 1, …)` would otherwise resolve to Haiku for any unknown input, including a floored role's.

`ALL_ROUTABLE_ROLES` (`packages/model-router/src/roleUniverse.ts`) is `@fx/roles`'s `ROLE_NAMES` (the 26 ported role cards — see `roles.md`) concatenated with `SITE_KIT_ROLES`, which is currently an empty array: no site-kit-specific role names exist anywhere in this repo's code today, so the extension point is left empty rather than invented. `tableSchema.ts`'s `validateRoutingRows` requires every `(role, size)` combination across `ALL_ROUTABLE_ROLES` and the three sizes to be present exactly once, and that no row violates its role's floor; `loadLiveRoutingTable` calls it on every read, so a floor-violating live table can never be loaded even if it somehow reached the database.

`saveProposedTable` validates every row's floor before opening a transaction, so a floor-violating proposal is rejected before it ever touches the database. `applyPromotionDecision` requires the target row to still be `status = 'proposed'` (`rowCount === 1`) before either promoting it to `live` (retiring whatever was previously live in the same transaction) or marking it `rejected` with a stored reason, throwing and rolling back otherwise — this closes paths that previously let a caller re-promote an already-rejected version or reject the currently-live one.

`eval/bootstrap.ts` is an owner-machine-only script (`pnpm --filter @fx/model-router eval:bootstrap`, guarded by `@fx/runtime`'s `assertLocalRunnerAllowed`) that replays a fixed task list across the three model tiers using the local runner, scores each replay, and writes `default-table/v1.json` plus a results file. `pnpm test` never runs it — `test/evalBootstrap.test.ts` exercises only its guard and its pure scoring/write logic with an injected fake `AgentRuntime`, at zero model tokens.

## Data it touches

`routing_tables` and `routing_rows`. See `../data-model.md`.

## Security notes

See `../security.md`. `escalate`'s clamp-on-unknown-model behavior and the floor checks repeated at every write/read path (`route`, `escalate`, `applyCustomerOverride`, `validateRoutingRows`, `saveProposedTable`) exist specifically so a floored role (`security-reviewer`, `security-expert`) can never end up running on a model below `sonnet-5`, whether the cause is a stale/corrupt table row, a customer override, or an escalation from a failed run.

## Tests

Run with `pnpm --filter @fx/model-router test` (`vitest run`). `test/route.determinism.test.ts` and a property test both call `route` repeatedly (the latter 1,000 times) against the same inputs to confirm it is deterministic. `test/route.live.pg.test.ts` and `test/proposal.pg.test.ts` run against a real Postgres instance via `test/globalSetup.ts`, with `fileParallelism: false` and a single forked worker since they mutate shared `routing_tables`/`routing_rows` state. `test/floors.test.ts`, `test/escalate.test.ts`, `test/tableSchema.test.ts`, `test/proposal.test.ts`, and `test/evalBootstrap.test.ts` cover the pure logic.

## Known gaps

`SITE_KIT_ROLES` is an empty array pending a decision on what the two site-kit-specific role names actually are — see `packages/model-router/src/roleUniverse.ts`'s own comment, which notes this was flagged rather than invented.
