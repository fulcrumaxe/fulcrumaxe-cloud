# roles

`@fx/roles` is the ported set of role cards — the hosted product's version of the engine's `.claude/agents/*.md` files, rewritten so every reference to an engine-only script becomes a hosted tool name (or nothing at all) — plus the manifest that tells the orchestrator which model, spend cap, and mode each role runs under, and the tool registry that ties the two together.

Sources:
- `packages/roles/src/`
- `packages/roles/cards/`
- `packages/roles/test/`
- `packages/roles/package.json`

## What it does

`packages/roles/cards/` holds 26 role card files (confirmed by `ls packages/roles/cards`), one Markdown file per role — the actual prompt text an agent run reads. `ROLE_MANIFEST` (`packages/roles/src/manifest.ts`) is the corresponding data table: one entry per card, giving its trigger condition, default mode, which modes it may legally be set to, its default model tier, its per-spawn spend cap, whether it needs a browser, and whether it has write access. `TOOL_REGISTRY` (`packages/roles/src/tools.ts`) lists every tool name a card is allowed to reference, and which engine-era script (if any) that tool replaced in the port.

## Public surface

`packages/roles/src/manifest.ts` (the package's `main`/`types` entry) exports `RoleMode`, `RoleManifestEntry`, `ROLE_MANIFEST`, `getRoleEntry`, `ROLE_NAMES`. `packages/roles/src/tools.ts` exports `ToolRegistryEntry`, `TOOL_REGISTRY`, `getToolEntry`, `TOOL_NAMES`. `packages/roles/src/next-role-request.ts` exports `NextRoleRequest`, `NextRoleRequestField`, `isNextRoleRequestField`, `ResumeCause`, `ResumeContext`, `RESUME_CAUSES`, `isResumeCause`.

## How it works

**Manifest-to-card binding.** The manifest and the card files are bound by name and cross-checked by tests, not by a runtime lookup inside this package: `packages/roles/test/manifest.test.ts` asserts that `ROLE_NAMES` matches a frozen list of the 26 expected role names one-for-one, and that every card filename in `packages/roles/cards/` (minus `.md`) has exactly one matching `ROLE_MANIFEST` entry and vice versa. The orchestrator reads a `ROLE_MANIFEST` entry to decide which model/mode/cap to spawn a role with, then reads the matching `cards/<name>.md` file for the actual prompt text — the manifest carries no prompt text itself.

**Binding cards to tools.** `packages/roles/test/tools.test.ts` extracts every tool token a card's Markdown text references (a backticked simple name like `` `gh` ``, the literal string `fx test`, the literal string `next_role_request`, or an `mcp__<server>__*` pattern) and cross-checks it bidirectionally against `TOOL_REGISTRY`: every tool a card references must exist in the registry, and every registry entry must be referenced by at least one card. This is how the manifest/registry stays in sync with the cards without a runtime binding step — a card that references an unregistered tool, or a registry entry no card uses, fails this test.

**Card content constraints.** `packages/roles/test/cards.test.ts` checks every card against a fixed forbidden-reference pattern (a Discussion number, an engine `scripts/`/`backend/` path, a home-directory path, or the operator's own account name) and confirms no card names "Claude Code" or a fixed `SendMessage` address — a card asks the orchestrator to start another role via the `next_role_request` AGENT_OUTPUT field (`packages/roles/src/next-role-request.ts`) rather than spawning or messaging directly.

**`next_role_request` and resume.** `NextRoleRequestField` is either `null` or `{ roles: string[], reason, context }` — `roles` is always an array, even for a single role, so a fan-out (a consensus panel) and an ordinary single-role request share one shape. `ResumeContext` (`{ cause, reason? }`) is what the orchestrator attaches when it resumes a run that requested another role: `cause` is one of `"child_result"`, `"timeout"`, or `"request_refused"`, so a resumed role branches on a typed cause rather than parsing free text.

## Data it touches

None directly — `ROLE_MANIFEST` and `TOOL_REGISTRY` are static, in-code tables, not database-backed. See `../data-model.md` for where a tenant's per-role mode override (`role_settings`) actually lives.

## Security notes

See `../security.md`. `needsBrowser: true` is set for exactly `browser-tester`, `tui-tester`, and `visual-verifier` (asserted by `packages/roles/test/manifest.test.ts`); `writeAccess: true` marks the roles permitted to push commits (`executor`, `docs-writer`, `runbook-writer`, `ux-designer`) — every other role is read-only plus GitHub metadata writes. This `writeAccess` list is defined separately from `@fx/gh-policy`'s own write-scoping, and the two differ at HEAD: `ROLE_PERMISSIONS` in `packages/gh-policy/src/rolePermissions.ts` gives `contents: "write"` to `executor`, `docs-writer`, `release-manager`, and `runbook-writer` — `release-manager` has `contents: "write"` there but `writeAccess: false` in `packages/roles/src/manifest.ts`, while `ux-designer` has `writeAccess: true` here but no `contents: "write"` entry (and no `ROLE_PUSH_PREFIX` entry) in `rolePermissions.ts`.

## Tests

Run with `pnpm --filter @fx/roles test` (`vitest run`). `test/manifest.test.ts` covers the manifest/card-name binding and every manifest field's shape (required fields present, `allowedModes` contains `defaultMode`, `perSpawnCapUsd` positive, `defaultModel` one of the three known tiers) plus a frozen default-mode table cross-check. `test/tools.test.ts` covers the card/tool-registry binding, including two deliberate-failure fixtures that confirm the cross-check actually catches a missing or unreferenced tool rather than passing vacuously. `test/cards.test.ts` covers the forbidden-reference scan, also with a deliberate-violation fixture. `test/next-role-request.test.ts` and `test/resume-context.test.ts` cover the typed envelope-field shapes. `test/declared-classes.test.ts` (`#144`) is this package's half of the `@fx/decisions` declared-classes guard: it scans `src/tools.ts` for an own `decisionType` property on a `ToolRegistryEntry` and `cards/*.md` for a `decision_types:` frontmatter key, then asserts every real declaration resolves via `@fx/decisions`'s `assertDeclarationsResolve`/`findUnresolvedDeclarations` — against fixtures, since no tool or card declares a decision type yet.
