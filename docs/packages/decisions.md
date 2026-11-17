# @fx/decisions

The decision-policy layer: a catalogue of decision types, three named
presets (Cautious/Balanced/Autonomous), `decide()` -- a pure, total
function that resolves one decision request to a class and a disposition --
and the pure helpers around an ask: its answer window, its escalation route
and the action rules a person can save.
This package is not the same thing as `packages/db/src/decisions.ts`, which
reads and writes the *stored* per-repo dial settings and receipts tables;
see [`db.md`](./db.md) for that. This package is the pure policy logic that
a dial setting selects between.

Sources:
- `packages/decisions/package.json`
- `packages/decisions/src/index.ts`
- `packages/decisions/src/types.ts`
- `packages/decisions/src/catalogue.ts`
- `packages/decisions/src/presets.ts`
- `packages/decisions/src/decide.ts`
- `packages/decisions/src/declared.ts`
- `packages/decisions/src/askPolicy.ts`
- `packages/decisions/src/escalation.ts`
- `packages/decisions/src/workingHours.ts`
- `packages/decisions/src/rules.ts`
- `packages/decisions/src/ruleGlob.ts`
- `packages/decisions/src/rulePointer.ts`
- `packages/decisions/src/platformAskFacts.ts`
- `packages/decisions/src/reversalWindow.ts`
- `packages/decisions/src/labels.ts`
- `packages/decisions/src/engineDecision.ts`
- `packages/roles/cards/executor.md`
- `packages/decisions/test/`

## What it does

Classifies a decision an agent role wants resolved into one of three
classes borrowed from an external taxonomy the code cites by its arXiv
identifier (`automated_with_monitoring`, `human_over_the_loop`,
`human_in_the_loop`), then resolves that class to a disposition
(`act`, `announce`, or `ask`) according to which of three presets the
account has selected. The package is pure: no network, filesystem,
database, or model-client access anywhere in `src/`. `package.json`'s
`description` field frames it the same way -- a catalogue, three presets
as data, and a resolver the orchestrator calls -- and the code matches it.

## Public surface

`package.json` points `"main"`/`"types"`/`"exports"` at `src/index.ts`,
which re-exports:

- `catalogue.ts`: `CATALOGUE`, `CATALOGUE_IDS`, `CATALOGUE_VERSION`, `DEFAULT_REVERSAL_WINDOW_HOURS`, `getCatalogueEntry(id)`
- `reversalWindow.ts`: `reversalWindowFor`
- `labels.ts`: `DECISION_LABELS`, `decisionLabel`
- `engineDecision.ts`: `ENGINE_DECISION_TYPES`, `ENGINE_SPEC_TAGS`, `isEngineDecisionType`, `resolveEngineDecision` (types `EngineDecisionType`, `EngineSpecTag`, `EngineResolution`)
- `presets.ts`: `CAUTIOUS_PRESET`, `BALANCED_PRESET`, `AUTONOMOUS_PRESET`, `PRESETS`, `UnknownPresetError`, `getPreset(name)`
- `decide.ts`: `DecisionRequestClassFieldRejectedError`, `decide(entry, settings, request)`
- `declared.ts`: `PLATFORM_DECLARATIONS`, `UndeclaredCatalogueEntryError`, `assertDeclarationsResolve`, `findUnresolvedDeclarations`, `resolveDeclaredEntry` (`DeclaredEntry` type)
- `askPolicy.ts`: `resolveAskPolicy`, the ask window and notify constants, `presetDefaultTimeoutOutcome`, `AskPolicyNotAskedError`
- `escalation.ts`: `validateRoute`, `resolveAskRoute`, `planEscalation`, `r5DefaultPlan` and the route limits (it re-exports `deferToWorkingHours`, `isValidTimeZone` and `HOURS_MAX_WINDOWS` from `workingHours.ts`)
- `rules.ts`: `validateRuleSet`, `evaluateRules`, `clampRuleOutcome`, `tightenAskDisposition`, `checkFieldPath`, `RULE_LIMITS`; `ruleGlob.ts`: `globMatch`; `rulePointer.ts`: `parsePointer`, `resolvePointer`
- `platformAskFacts.ts`: `PLATFORM_ASK_FACTS`, `platformAskRequest`, `usdCeilCents`
- `types.ts` (types only): `CatalogueEntry`, `CustomerProximity`, `DataSensitivity`, `DecisionClass`, `DecisionRequest`, `DecisionResult`, `DecisionSettings`, `Disposition`, `Preset`, `PresetDispositions`, `PresetName`, `ReversalDeclaration`

## How it works

`catalogue.ts`'s `CATALOGUE` is a fixed array of 24 entries at `CATALOGUE_VERSION` 11 (2 in
`automated_with_monitoring`, 16 in `human_over_the_loop`, 6 in
`human_in_the_loop`). `test/catalogue-version.test.ts` pins a hash of the catalogue and the presets next to that number, so changing either without bumping it fails. The receipt writer stamps the version on every receipt. The entries added after the first fifteen include seven for starting work: `start_work_small`,
`start_work_bug`, `start_work_doc` and `launch_sub_item` (class 2, default
`ask`), and `start_parent_item`, `spend_past_envelope` and
`start_after_reclassify` (class 3, ask only). The pure resolvers that read them,
`resolveStart` and `resolveSubItemLaunch`, live in `packages/core/src/autonomy/`.
Version 11 added the engine's three decisions (#993): `engine_spawn`,
`engine_merge` and `engine_spec_ready`, all class 2, default `ask`, internal
only. `engine_merge` is marked not reversible (a merge cannot be undone from
the cloud). `engine_spec_ready` allows only `act` or `ask`. `engineDecision.ts`
resolves them, purely: `resolveEngineDecision` takes the decision type, the
repo's stored dial and, for a Spec, the tag the engine read from the title. A
stored value the entry does not allow fails closed to `ask`. A `feature` or
`critical` Spec is resolved through `start_parent_item` instead of the dial,
so it asks at every preset; `small`, `bug`, `doc` and `process` follow the
dial; any other or missing tag asks. `labels.ts` has a plain-words label for
each of the three.
Each entry declares an id, its class, a default
disposition, the set of dispositions that entry is allowed to resolve to,
the timeout outcomes an unanswered ask may take (`timeoutOutcomes`: empty for class 1, otherwise `stop_and_flag`, plus `proceed_recommended` for only a few class-2 entries),
its reversal window in hours (`reversalWindowHours`, 24 on every entry, read through `reversalWindowFor`),
and how its effect can be reversed (`reversible_before_build`,
`compensating_work`, or `not_reversible` with a required reason string).
`getCatalogueEntry` looks one up by id; a type absent from the catalogue
resolves to `undefined`.

`presets.ts`'s three presets are data, not code paths: each fixes
`automated_with_monitoring` to `act` and `human_in_the_loop` to `ask`, and
only varies what `human_over_the_loop` proposes (`ask` for Cautious,
`announce` for Balanced, `act` for Autonomous) -- the one axis a preset
actually moves.

`decide.ts`'s `decide(entry, settings, request)` first rejects any
`request` object that carries its own `class` property, however it got
there (`DecisionRequestClassFieldRejectedError`) -- the resolved class
always comes from the catalogue entry a tool or role statically declares,
never from the request itself. An unknown type (`entry === undefined`)
always resolves to `human_in_the_loop`/`ask`, the same class an explicitly
`human_in_the_loop` entry always resolves to. For a known entry, the
selected preset supplies a proposed disposition for that entry's class,
then `clampDisposition` walks the `act -> announce -> ask` ordering forward
from that proposal until it finds one the entry's own
`allowedDispositions` permits -- so a proposal a catalogue entry does not
allow only ever degrades toward the more conservative value, never
escalates past what the preset asked for. `decide()` never reads
`entry.reversal`, `entry.customerProximity` or `entry.dataSensitivity`;
those three fields exist on `CatalogueEntry` for later routing/reporting
uses, not for this resolution step.

## Start-resolver reason vocabulary

`resolveStart` and `resolveSubItemLaunch` (in `packages/core/src/autonomy/`) answer with a fixed set of reason names. They are vocabulary, not free text: callers, receipts and screens key on them, and `packages/core/test/autonomy-reasons-doc.test.ts` fails if this list and the exported `START_REASONS` / `SUB_ITEM_REASONS` differ. Both resolvers take a preset, not a stored dial row. The caller that starts work must map "no row" and a single-dial override to the disposition the person actually set before it passes a preset in.

### Start reasons

- `owned_by_internal_loop` — the repo's own development loop owns the item; refused.
- `engine_loop_repo` — the default branch holds the engine loop's project file; the person decides.
- `external_needs_approval` — the proposal came from someone without admin or maintain access; the person decides.
- `not_checked` — the verifier has not confirmed the proposal (pending, refuted, failed or not run); the person decides.
- `category_unknown` — no category yet, or the category is a question or outside the known set; the person decides.
- `free_preview` — the account is still on the free preview; refused.
- `no_write_install` — the repo has no active write App install; refused.
- `parent_first_start` — a feature, project or critical item; its first start is always asked.
- `dial` — no hard rule applied and the person's dial for this decision gave the answer.

### Sub-item launch reasons

- `parent_not_approved` — the parent has no person's approval record; ask.
- `respec_needs_approval` — the Spec changed since the parent was approved; ask for a new approval.
- `spec_version_unknown` — the approved or current Spec version is missing; ask.
- `spec_keys_unknown` — the approved Spec's list of planned keys was not supplied; ask.
- `sub_item_kind_unknown` — the sub-item kind is not one of the four known kinds; ask.
- `sub_item_widens_scope` — a feature-sized or unclassified child, or a key outside the approved Spec; handled as a new item.
- `parent_envelope_reached` — the parent's envelope does not cover the first run; wait.
- `owned_by_internal_loop` — the parent is owned by the repo's own loop; refused.
- `engine_loop_repo` — the parent's repo holds the engine loop's project file; ask.
- `external_needs_approval` — the parent came from someone without admin or maintain access; ask.
- `dial` — every guardrail passed and the `launch_sub_item` dial gave the answer.

### A person's approval of a split parent

A person's "Approve the Spec and build" on a split parent (a Spec that plans two or more pull requests) starts its planned PRs that are ready now, even when `launch_sub_item` is set to ask. "Ready" means no launch blocker, and a planned PR that waits on a sibling is not ready. Each start is that person's own launch of the planned PR: the same checks and the same `launch_sub_item` receipt as an Approve on the child's card. The receipt also carries `approval_id`, which names the parent's approval it came from, so the two kinds of launch can be told apart. The dial still governs every start that happens without a click, including a planned PR that becomes ready later.

## The declared-classes guard

`declared.ts`'s `resolveDeclaredEntry(declaration, catalogue?)` resolves one static declaration (`{ source, decisionType }`, e.g. a tool or role card naming a catalogue id) to its `CatalogueEntry`, or `undefined` when the id isn't in the catalogue. `findUnresolvedDeclarations` returns every declaration that fails to resolve, and `assertDeclarationsResolve` throws `UndeclaredCatalogueEntryError` if that list is non-empty — a declaration naming no catalogue entry is a build/test-time failure, never a silent runtime default (`#144`). This module only resolves a declaration once handed one; the scan that finds real declarations in `packages/roles/src/tools.ts` (an own `decisionType` property on a `ToolRegistryEntry`) and `packages/roles/cards/*.md` (a `decision_types:` frontmatter key) lives in `packages/roles/test/declared-classes.test.ts` instead, since `@fx/roles` owns those files. A third source, `PLATFORM_DECLARATIONS`, lists the types the platform raises itself (`run_extension`), which must appear there and in no card or tool. At HEAD the one role card that declares decision types is `packages/roles/cards/executor.md` (`nonbreaking_refactor_approach` and `test_strategy_choice`); fixtures that use the declaration convention directly prove the scan is not vacuous.

## Data it touches

None directly -- this package has no database, filesystem or network
access anywhere in `src/`. A tenant's currently-selected preset name (the
`DecisionSettings.preset` this package's `decide()` takes as an input) is
stored and read by `packages/db/src/decisions.ts`; see
[`db.md`](./db.md) and [`../data-model.md`](../data-model.md).

## Security notes

Not applicable in the security-review sense (no data access), but one
design property is relevant to how much this package can be trusted: an
inbound `DecisionRequest` carrying its own `class` field is always
rejected before anything else runs (`decide.ts`'s
`DecisionRequestClassFieldRejectedError`), so an agent that wrote a
decision request can never assign itself a more lenient class than the
catalogue entry for its type actually has.

## Ask policy

`askPolicy.ts` (`packages/decisions/src/askPolicy.ts`) holds `resolveAskPolicy(entry, preset, settings, repoId)`, which is pure and returns
`{ answerWindowMinutes, timeoutOutcome, notify }` for one ask. The first non-null value per field wins, in the order repo + type, repo +
`'*'`, account + type, account + `'*'`, then the preset default (24 hours; Cautious stops, Balanced goes ahead on class 2, Autonomous goes
ahead where the entry allows it). The outcome is clamped to the entry's `timeoutOutcomes`, and the window to 15 minutes through 14 days.
Class 1 is never asked, so it has no policy. The customer's rows are stored by `packages/db/src/decisionAskSettings.ts` (migration 0812).

## Escalation routes

`escalation.ts` is the pure side of who is told about an ask and when. A route has 1 to 4 levels, each aimed at all owners and admins or at one named owner or admin, with 5 minutes to 7 days before the next level; optional working-hours windows (`workingHours.ts`: ISO weekdays, `HH:MM` wall-clock in an IANA zone, at most 14 windows, an empty list meaning always working); and a repeat of 0 to 3 extra laps. A route with no levels is a tombstone meaning "this scope has no route of its own". `resolveAskRoute` looks up repo + type, repo + `*`, account + type, account + `*`, falling past a tombstone to the next step; when nothing applies the caller plans `r5DefaultPlan` (every owner and admin when the ask is raised, one reminder when it goes overdue). `planEscalation` turns a route into the steps, and caps messages at one per person per level for the whole life of an ask however large the repeat is. The clock is an input, never read.

## Action rules

`rules.ts` is the grammar, validator and evaluator for a person's ordered list of `{ id, outcome, when }` rules, where the outcome is `approve`, `deny` or `ask` and the first matching rule decides. A rule reads only the request's tool, server and arguments, the instance name and platform-computed facts, never an agent's reasoning or context; strings match by the bounded glob in `ruleGlob.ts` (`*` and `?` only, no regular expression), and field paths are JSON Pointers resolved over own properties only (`rulePointer.ts`). Every set is bounded (`RULE_LIMITS`: 200 rules, depth 8, 64 nodes per rule) and an evaluation that exceeds its node or comparison budget answers `ask`. `clampRuleOutcome` keeps a rule from approving more than the `tool_call` dial allows, and `tightenAskDisposition` lets a rule make a platform-raised ask stricter but never looser, for `spend_past_envelope`, `run_extension` and the three start-work types only. `platformAskFacts.ts` lists the facts a rule may name for those asks (dollar figures rounded up to the cent, counts, text).

## Tests

`packages/decisions/test/` covers the catalogue's fixed shape, content and version pin,
`decide()`'s resolution and clamping logic (including the rejected-class-field
case), the ask policy, escalation, the rule grammar and its bounds, that every preset fixes classes 1 and 3 the same way and differs
only on class 2, an import-boundary scan, and `declared.test.ts` for
`declared.ts`'s resolution/assertion logic. A second, workspace-wide test
extends the package-local "no never-dialed disposition flag" check across
every file in the repo, bounded to real identifiers so it doesn't trip on
prose that merely mentions the banned name. `pnpm test` runs plain
`vitest run` -- no database, so no `globalSetup` or ephemeral Postgres
cluster is involved, unlike every other package in this task.
