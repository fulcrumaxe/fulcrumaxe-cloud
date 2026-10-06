# @fx/design

The one shared design layer for `apps/web` and
[sitekit-template](sitekit-template.md): a token schema, two shipped token
sets, a base stylesheet, and a component contract with both a string-HTML and
a React renderer that share the same class names.

Sources:
- `packages/design/src/index.ts`
- `packages/design/src/schema/tokenSet.ts`
- `packages/design/src/css/tokens.ts`
- `packages/design/src/css/index.ts`
- `packages/design/src/components/index.ts`
- `packages/design/src/html/index.ts`
- `packages/design/src/react/index.tsx`
- `packages/design/tokens/terminal.json`
- `packages/design/tokens/dark.json`
- `packages/design/package.json`

## What it does

`packages/design/src/schema/tokenSet.ts`'s `TokenSet` schema is the single
source of every colour, spacing step, type-scale step, radius and container
width a surface renders with — a component never hardcodes a value; it reads a
CSS custom property instead. `packages/design/src/css/tokens.ts` loads the two
shipped sets (`packages/design/tokens/terminal.json`,
`packages/design/tokens/dark.json`) and `renderTokens(set)` emits them as one
`:root { --token: value; ... }` block. `renderStylesheet(set)`
(`packages/design/src/index.ts`) concatenates that block with the static
component rules in `packages/design/src/css/base.css` (via `getBaseCss`) —
this is what both `apps/web/app/layout.tsx` and
`packages/sitekit-template/src/render.ts` call to get their stylesheet.

## Public surface

Exported from `packages/design/src/index.ts`: `TOKEN_SETS`, `renderTokens`,
`BASE_CSS`, `getBaseCss`, `TokenSet`, `ColorTokens`, `SpacingTokens`,
`TypeTokens`, `ContainerTokens`, `PartnerOverride`, `applyPartnerOverride`,
`renderStylesheet`, plus the `components` and `html` namespaces
(`packages/design/src/components/index.ts`, `packages/design/src/html/index.ts`).
React wrappers are exported separately from `@fx/design/react`
(`packages/design/src/react/index.tsx`) — the plain `index.ts` barrel
deliberately does not re-export them, since a consumer with no `jsx` compiler
option configured (such as `packages/sitekit-template`) would otherwise have
this package's `.tsx` source type-checked against it the moment it imports
anything from this barrel.

## How it works

`packages/design/src/components/index.ts` is the one place component class
names are declared (`CLASSES`) and prop shapes are typed (`HeaderProps`,
`FooterProps`, `ButtonProps`, `CardProps`, `CodeBlockProps`,
`StateMessageProps`, `EvidenceLinkProps`). Both
`packages/design/src/html/index.ts` (plain string-returning functions) and
`packages/design/src/react/index.tsx` (React components) import their class
names and prop types from that one module, so the two renderers cannot drift
apart independently — neither is the "real" one.

`PartnerOverride` (`packages/design/src/schema/tokenSet.ts`) is the one
sanctioned white-labelling mechanism: it accepts only `colors.*` fields,
excluding `SEMANTIC_CONSTANT_KEYS` (`danger`, `dangerDim`, `warn`, `warnDim` —
kept fixed across every theme so "error" and "caution" keep their meaning
regardless of a partner's brand colours), and `.strict()`s out anything else,
including every `spacing.*`/`type.*`/`radius`/`container.max` structural key.
`applyPartnerOverride(set, override)` re-validates the override and returns a
new `TokenSet` with only those colour keys replaced.

## Data it touches

None — token sets are loaded from the JSON files under
`packages/design/tokens/`, not from a database. See [data model](../data-model.md).

## Security notes

Not applicable — this package renders styling, not user input. See
[security model](../security.md) for the repo-wide picture.

## Tests

`packages/design/test/hardcoded-guard.test.ts` scans
`packages/design/src`, `packages/sitekit-template/src`, `apps/web/app`, and
`sites/` for a hardcoded colour or spacing literal outside the token chain,
and asserts zero violations in the real surfaces (plus a deliberate-violation
fixture to prove the scan actually catches something).
`packages/design/test/html-react-parity.test.tsx` asserts the HTML-string and
React renderers normalize to identical markup for every shared component.
`packages/design/test/token-swap.test.ts` asserts `SEMANTIC_CONSTANT_KEYS`
agree between the two shipped sets and every other key differs.
`packages/design/test/partner-override.test.ts` and
`packages/design/test/focus-ring.test.ts` cover the override schema and a
focus-visible CTA ring respectively. Run with `pnpm test` from
`packages/design/` (`vitest run`); `pnpm run typecheck` runs `tsc --noEmit`.

## Known gaps

None found in this package's own scope at this HEAD.
