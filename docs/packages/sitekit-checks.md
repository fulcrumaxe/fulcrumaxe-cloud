# @fx/sitekit-checks

Deterministic, zero-model-token verification checks for a rendered
[sitekit-template](sitekit-template.md) output directory, ported from an
external `os-site-v2/tools` project into generic, multi-tenant form — none of
them make a network call, spend a model token, or write outside the directory
they check.

Sources:
- `packages/sitekit-checks/src/index.ts`
- `packages/sitekit-checks/src/types.ts`
- `packages/sitekit-checks/src/checks/links.ts`
- `packages/sitekit-checks/src/checks/meta.ts`
- `packages/sitekit-checks/src/checks/nojs.ts`
- `packages/sitekit-checks/src/checks/weight.ts`
- `packages/sitekit-checks/src/checks/redaction.ts`
- `packages/sitekit-checks/src/checks/i18nCatalogue.ts`
- `packages/sitekit-checks/src/checks/i18nChrome.ts`
- `packages/sitekit-checks/README.md`

## What it does

Each check module exports `run(renderedDir, options?): Promise<CheckResult>`
(`packages/sitekit-checks/src/types.ts`'s `CheckRun`), returning `{ ok, findings }`
where each `Finding` carries a `path`, a machine-stable `kind`, a message, and a
severity of `error` (fails the check) or `advisory` (reported, never fails it).
`packages/sitekit-checks/src/index.ts`'s `CHECKS` registry maps each check's
original tool name to its `run` function, so a caller can iterate all seven in
one pass.

The seven checks, one file each under `packages/sitekit-checks/src/checks/`,
match the registry one to one:

| Check | Source file | Purpose |
|---|---|---|
| `check-links` | `links.ts` | Every internal `href`/`src` resolves inside `renderedDir`; any external link whose host is not in `options.siteDomains` is flagged `needs_review`. Never checks link *liveness*. |
| `check-meta` | `meta.ts` | A missing `<title>`/description, or two pages sharing one, is a hard failure; title/description length is advisory only. |
| `check-nojs` | `nojs.ts` | Every page must say something (a heading, a sentence, a link) before any script runs — a minimum visible-word count with CJK-aware counting. |
| `check-weight` | `weight.ts` | Bounds the byte cost of a page's first cold visit — the HTML plus every same-origin stylesheet/script/image it references up front, excluding anything JavaScript fetches later or lazily loads. |
| `check-redaction` | `redaction.ts` | Scans rendered output for a caller-supplied deny-list of private hosts, account names and email patterns, plus a fixed set of generic secret-shaped patterns (tokens, keys, hex blobs, home paths). |
| `check-i18n-catalogue` | `i18nCatalogue.ts` | Validates `<renderedDir>/i18n/<locale>/<page>.json` translation catalogues against the English `<main>` they translate: fingerprint match, tag-skeleton match, and every dollar amount/licence id/generated-block marker preserved. |
| `check-i18n-chrome` | `i18nChrome.ts` | Every wanted nav/footer label (from `options.wantedLabels` or `<renderedDir>/i18n/chrome-labels.json`) must have a translation in every locale in `<renderedDir>/i18n/chrome.json`. |

## Public surface

`packages/sitekit-checks/src/index.ts` exports each check individually
(`checkLinks`, `checkMeta`, `checkNojs`, `checkWeight`, `checkRedaction`,
`checkI18nCatalogue`, `checkI18nChrome`), their option types, the `CHECKS`
registry, `GENERIC_LEAK_PATTERNS`/`GENERIC_LEAK_PLANTS` (from `redaction.ts`),
`i18nFingerprint` (from `i18nCatalogue.ts`), and the shared `Finding`,
`CheckResult`, `CheckOptions`, `CheckRun` types (`types.ts`).

## How it works

The originals this package ports from were wired to one fixed site (a
hardcoded directory, a specific page list, one deployment's own private
strings and nav script). This port instead: discovers pages by walking
`renderedDir` for `*.html` (`packages/sitekit-checks/src/lib/walk.ts`) rather
than a fixed page list; takes `check-redaction`'s deny-list and
`check-i18n-chrome`'s wanted-label set as `options` instead of hardcoding one
org's values.

## Data it touches

None — every check reads only files under the `renderedDir` it is pointed at.

## Security notes

`check-links`'s external-host flagging and `check-redaction`'s deny-list scan
are the two checks with direct security relevance (catching an unintended
external reference or a leaked private string in generated output); see
[security model](../security.md) for the repo-wide picture.

## Tests

Every check has at least one passing and one failing fixture under
`packages/sitekit-checks/test/fixtures/<check>/`, exercised by
`packages/sitekit-checks/test/checks/*.test.ts`. Run with `pnpm test` from
`packages/sitekit-checks/` (`vitest run`); `pnpm run typecheck` runs
`tsc --noEmit`. `packages/sitekit-checks/test/parity.sh` additionally runs the
real original Python/Node tool (read from an external, unmodified directory)
against the same fixture this package's TypeScript port runs and diffs
pass/fail, recorded in `packages/sitekit-checks/test/PARITY.md`; `check-redaction`
is excluded from that parity run because the original makes a live,
unconditional network call with no offline path.

## Known gaps

`packages/sitekit-checks/package.json` ships its own package-local
`pnpm-workspace.yaml`, described as a temporary standalone-install path ahead
of a root workspace landing.
