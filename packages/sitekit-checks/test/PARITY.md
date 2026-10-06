# Parity report — D#2606 K02

Generated 2026-09-29T14:08:15Z by test/parity.sh against
`$ORIGINAL_TOOLS_DIR` (read-only, unmodified — copied into a scratch
harness so each original tool's own `SITE = HERE/../formal-support`
resolves to this run's fixture instead of the real os-site-v2 site).

For each check: the SAME fixture content is run through the original
tool and through the TypeScript port, and their pass/fail is compared
(the number that gates this script's exit code). Finding counts are
also printed for a reader to check, but are not diffed automatically —
the original prints prose lines per finding while the port returns
structured Finding objects, and they are not always 1:1 countable (see
check-i18n-chrome's note below, and the check-links note on advisory
findings the original does not have a concept of).


### check-links — fail fixture

- original: exit=1 (pass=false)
- port:     ok=false findings=3

```
  original>   broken internal links:
  original>     index.html                         /missing.html                          no such file
  original>     index.html                         faq.html                               relative path (this site uses absolute)
  original>     index.html                         /faq.html#nope                         no such anchor on the target
  port>     {"ok":false,"findingCount":3,"findings":[{"path":"/","kind":"broken_link","message":"no such file: /missing.html","severity":"error"},{"path":"/","kind":"relative_path","message":"relative path (this site uses absolute): faq.html","severity":"error"},{"path":"/","kind":"missing_anchor","message":"no such anchor on the target: /faq.html#nope","severity":"error"}]}
```

### check-links — pass fixture

- original: exit=0 (pass=true)
- port:     ok=true findings=1
- note: the port additionally reports an advisory (non-failing) external_needs_review finding for the fixture's example.com link — K02 item 4, which the original tool does not check at all

```
  original>   4 internal links all resolve (1 with anchors), across 2 pages
  port>     {"ok":true,"findingCount":1,"findings":[{"path":"/","kind":"external_needs_review","message":"outbound link to example.com is outside the site's own domains: https://example.com/docs","severity":"advisory"}]}
```

### check-meta — fail fixture

- original: exit=1 (pass=false)
- port:     ok=false findings=2

```
  original>   metadata problems:
  original>     /                                                              no <title>
  original>     /faq.html, /                                                   share a description: "Connect a repo and get a production website where "
  port>     {"ok":false,"findingCount":2,"findings":[{"path":"/","kind":"missing_title","message":"no <title>","severity":"error"},{"path":"/faq.html, /","kind":"duplicate_description","message":"share a description: \"Connect a repo and get a production website where \"","severity":"error"}]}
```

### check-meta — pass fixture

- original: exit=0 (pass=true)
- port:     ok=true findings=0

```
  original>   titles and descriptions present and unique across 2 pages
  port>     {"ok":true,"findingCount":0,"findings":[]}
```

### check-nojs — fail fixture

- original: exit=1 (pass=false)
- port:     ok=false findings=1

```
  original>   1 page(s) render under 40 words without JavaScript:
  original>     /                                            0 words
  original>   These are dead ends for a reader with scripting off and empty
  original>   results for a crawler. Add a sentence saying what is here.
  port>     {"ok":false,"findingCount":1,"findings":[{"path":"/","kind":"thin_without_js","message":"renders 0 words without JavaScript (under 40)","severity":"error"}]}
```

### check-nojs — pass fixture

- original: exit=0 (pass=true)
- port:     ok=true findings=0

```
  original>   every page renders at least 40 words without JavaScript (1 pages)
  port>     {"ok":true,"findingCount":0,"findings":[]}
```

### check-weight — fail fixture

- original: exit=1 (pass=false)
- port:     ok=false findings=1

```
  original>   over the 80 KB JavaScript budget:
  original>     index.html                         97.7 KB of script
  original>   run tools/check-weight.py --report for the breakdown
  port>     {"ok":false,"findingCount":1,"findings":[{"path":"/","kind":"over_js_budget","message":"97.7 KB of script over the 80 KB JS budget","severity":"error"}]}
```

### check-weight — pass fixture

- original: exit=0 (pass=true)
- port:     ok=true findings=0

```
  original>   heaviest script load: index.html at 0 KB of 80 KB
  original>   1 pages under the 400 KB budget (heaviest: index.html at 0 KB)
  port>     {"ok":true,"findingCount":0,"findings":[]}
```

### check-i18n-catalogue — fail fixture

- original: exit=1 (pass=false)
- port:     ok=false findings=2

```
  original>   FAIL es/index.html
  original>        source fingerprint does not match the current English <main>
  original>        '$99' appears 1x in English, 0x in translation
  original>   1 catalogues checked, 1 failing
  port>     {"ok":false,"findingCount":2,"findings":[{"path":"/i18n/es/index.html.json","kind":"i18n_catalogue_mismatch","message":"source fingerprint does not match the current English <main>","severity":"error"},{"path":"/i18n/es/index.html.json","kind":"i18n_catalogue_mismatch","message":"\"$99\" appears 1x in English, 0x in translation","severity":"error"}]}
```

### check-i18n-catalogue — pass fixture

- original: exit=0 (pass=true)
- port:     ok=true findings=0

```
  original>   1 catalogues checked, 0 failing
  port>     {"ok":true,"findingCount":0,"findings":[]}
```

### check-i18n-chrome — fail fixture

- original: exit=1 (pass=false)
- port:     ok=false findings=2
- note: run against test/fixtures/check-i18n-chrome/parity/ (not the unit-test fixture), which also translates the original's two hardcoded convenience labels — see comment above

```
  original>   es has no translation for: Sign in
  original>   es translates labels that no longer exist: Contact us (removed)
  original>   Edit formal-support/i18n/chrome.json. A nav item nobody translated appears in English on every translated page.
  port>     {"ok":false,"findingCount":2,"findings":[{"path":"/i18n/chrome.json","kind":"missing_chrome_translation","message":"es has no translation for: Sign in","severity":"error"},{"path":"/i18n/chrome.json","kind":"stale_chrome_translation","message":"es translates labels that no longer exist: Contact us (removed)","severity":"error"}]}
```

### check-i18n-chrome — pass fixture

- original: exit=0 (pass=true)
- port:     ok=true findings=0

```
  original>   4 chrome labels translated into 2 languages
  port>     {"ok":true,"findingCount":0,"findings":[]}
```

### check-a11y — pass fixture

- original: exit=0 (pass=true)
- port:     ok=true findings=0

```
  original>   no mechanical accessibility findings across 2 pages
  port>     {"ok":true,"findingCount":0,"findings":[]}
```

### check-a11y — exemptions fixture

- original: exit=0 (pass=true)
- port:     ok=true findings=0
- note: locked.html exemption passed as options

```
  original>   no mechanical accessibility findings across 2 pages
  port>     {"ok":true,"findingCount":0,"findings":[]}
```

### check-a11y — fail fixture (img_missing_alt)

- original: exit=1 (pass=false)
- port:     ok=false findings=1

```
  original>   accessibility findings:
  original>     index.html               img without alt            /a.png
  original>   1 finding(s)
  port>     {"ok":false,"findingCount":1,"findings":[{"path":"/","kind":"img_missing_alt","message":"img without alt: /a.png","severity":"error"}]}
```

### check-a11y — fail fixture (h1_count)

- original: exit=1 (pass=false)
- port:     ok=false findings=1

```
  original>   accessibility findings:
  original>     index.html               2 <h1> elements            expected exactly 1
  original>   1 finding(s)
  port>     {"ok":false,"findingCount":1,"findings":[{"path":"/","kind":"h1_count","message":"2 <h1> elements, expected exactly 1","severity":"error"}]}
```

### check-a11y — fail fixture (html_missing_lang)

- original: exit=1 (pass=false)
- port:     ok=false findings=1

```
  original>   accessibility findings:
  original>     index.html               no lang on <html>          
  original>   1 finding(s)
  port>     {"ok":false,"findingCount":1,"findings":[{"path":"/","kind":"html_missing_lang","message":"no lang on <html>","severity":"error"}]}
```

### check-a11y — fail fixture (input_missing_label)

- original: exit=1 (pass=false)
- port:     ok=false findings=1

```
  original>   accessibility findings:
  original>     index.html               input without a label      <input id="x" type="text" placeholder="Name">
  original>   1 finding(s)
  port>     {"ok":false,"findingCount":1,"findings":[{"path":"/","kind":"input_missing_label","message":"input without a label: <input id=\"x\" type=\"text\" placeholder=\"Name\">","severity":"error"}]}
```

### check-a11y — fail fixture (missing_skip_link)

- original: exit=1 (pass=false)
- port:     ok=false findings=1

```
  original>   accessibility findings:
  original>     index.html               no skip link               
  original>   1 finding(s)
  port>     {"ok":false,"findingCount":1,"findings":[{"path":"/","kind":"missing_skip_link","message":"no skip link","severity":"error"}]}
```

### check-headers — pass fixture

- original: exit=0 (pass=true)
- port:     ok=true findings=0
- note: options.headers replaces reading vercel.json

```
  original>   2 served data files all have a caching rule
  port>     {"ok":true,"findingCount":0,"findings":[]}
```

### check-headers — fail fixture

- original: exit=1 (pass=false)
- port:     ok=false findings=1
- note: options.headers replaces reading vercel.json

```
  original>   build artifacts with no caching rule: feed.xml
  original>   Vercel sends max-age=0, must-revalidate without one — a round
  original>   trip on every request for a file that changes only on deploy.
  original>   Add an entry to formal-support/vercel.json.
  port>     {"ok":false,"findingCount":1,"findings":[{"path":"/feed.xml","kind":"missing_cache_rule","message":"feed.xml has no cache-control rule; the host would send max-age=0, must-revalidate","severity":"error"}]}
```

### check-freshness — pass fixture

- original: exit=0 (pass=true)
- port:     ok=true findings=3
- note: the three sidecars with no declared timestamp pass the original on file mtime; the port gives an advisory sidecar_age_undeclared (ok stays true) — deliberate divergence

```
  original>   5 published data files within their freshness limits (oldest: history/stats.json at 1d)
  port>     {"ok":true,"findingCount":3,"findings":[{"path":"/code-metrics.json","kind":"sidecar_age_undeclared","message":"code-metrics.json declares no parseable timestamp, so its age cannot be verified (file mtime is not used)","severity":"advisory"},{"path":"/apps.json","kind":"sidecar_age_undeclared","message":"apps.json declares no parseable timestamp, so its age cannot be verified (file mtime is not used)","severity":"advisory"},{"path":"/feed.xml","kind":"sidecar_age_undeclared","message":"feed.xml declares no parseable timestamp, so its age cannot be verified (file mtime is not used)","severity":"advisory"}]}
```

### check-freshness — fail fixture (stale sidecar)

- original: exit=1 (pass=false)
- port:     ok=false findings=4

```
  original>   stale published data:
  original>     history/stats.json (100d old, limit 14d)
  original>   these are committed files that pages present as current —
  original>   regenerate them, or the site is quoting old numbers as new.
  port>     {"ok":false,"findingCount":4,"findings":[{"path":"/history/stats.json","kind":"sidecar_stale","message":"history/stats.json is 100d old, limit 14d","severity":"error"},{"path":"/code-metrics.json","kind":"sidecar_age_undeclared","message":"code-metrics.json declares no parseable timestamp, so its age cannot be verified (file mtime is not used)","severity":"advisory"},{"path":"/apps.json","kind":"sidecar_age_undeclared","message":"apps.json declares no parseable timestamp, so its age cannot be verified (file mtime is not used)","severity":"advisory"},{"path":"/feed.xml","kind":"sidecar_age_undeclared","message":"feed.xml declares no parseable timestamp, so its age cannot be verified (file mtime is not used)","severity":"advisory"}]}
```

### check-freshness — fail fixture (security.txt expiring in 10 days)

- original: exit=1 (pass=false)
- port:     ok=false findings=4

```
  original>   stale published data:
  original>     .well-known/security.txt (expires in 9d)
  original>   these are committed files that pages present as current —
  original>   regenerate them, or the site is quoting old numbers as new.
  port>     {"ok":false,"findingCount":4,"findings":[{"path":"/code-metrics.json","kind":"sidecar_age_undeclared","message":"code-metrics.json declares no parseable timestamp, so its age cannot be verified (file mtime is not used)","severity":"advisory"},{"path":"/apps.json","kind":"sidecar_age_undeclared","message":"apps.json declares no parseable timestamp, so its age cannot be verified (file mtime is not used)","severity":"advisory"},{"path":"/feed.xml","kind":"sidecar_age_undeclared","message":"feed.xml declares no parseable timestamp, so its age cannot be verified (file mtime is not used)","severity":"advisory"},{"path":"/.well-known/security.txt","kind":"security_txt_expiring","message":"security.txt expires in 9d (minimum 30d)","severity":"error"}]}
```

### K12a divergences (all deliberate, per D#3 C4)

- `check-a11y`: the original exempts `locked.html` (h1, skip link) and `404.html` (skip link) by basename and lists pages through `sitepages`; the port walks `renderedDir` and takes the exemptions as page-path options (`h1ExemptPaths`, `skipLinkExemptPaths`).
- `check-headers`: `options.headers` replaces reading `vercel.json`, and it is required; a call without it fails with `headers_config_missing` (the original crashes on a missing file).
- `check-freshness`: the five os-site-v2 sidecars become `options.sidecars`; the clock is the injected `options.now`; a file with no declared timestamp gets an advisory `sidecar_age_undeclared` instead of the original's file-mtime fallback, which always passes on rendered output. Parity fixtures for this check are generated relative to now, because a committed dated fixture would change verdict as time passes.

### check-redaction — NOT RUN

os-site-v2/tools/check-redaction.mjs imports `../formal-support/api/*.js`
and `lib/github.js`, and its main body makes a live GitHub GraphQL call
(`graphql(PR_QUERY, ...)`) unconditionally — there is no flag to skip it.
That call needs `GITHUB_TOKEN` and network access to api.github.com,
neither of which this harness has (K02's own pnpm test suite must make
zero network calls, and this parity run inherits that constraint rather
than reaching out to a live API from an unattended script).

Not marked matched. What WAS verified by hand: this port's
`GENERIC_LEAK_PATTERNS` and `GENERIC_LEAK_PLANTS` (src/checks/redaction.ts)
reproduce the original's `LEAKS`/`PLANTS` self-test pairs for the
categories that do not name this deployment's own private strings
(absolute home path, email address, GitHub token, OpenAI-style key, AWS
access key, 40+ char hex blob, plus a private-key-block and JWT pattern
the original does not have). The per-site deny-list — hosts, account
names, email patterns — is this port's own addition (K02 item 3: the
original hardcodes its own org's private strings, which cannot work for
a multi-tenant kit); it has no original counterpart to diff against, and
is instead covered by this package's own vitest suite
(test/checks/redaction.test.ts), including the B5 shape (a private
GitHub account and a private host) with invented placeholder names.

The `evidenceCommits` exemption (an evidence link's exact commit segment) is opt-in and off in the parity run: without it every finding is the original's.

## Browser checks (check-render, check-a11y-structure)

Run by the PR reviewer, not the author: the author's sandbox could not run bash. Output below is the reviewer's
parity run, pasted unedited. Divergences: viewports are an option (default 390 and 1280), themes are opt-in
(the original always renders three), pages come from findHtmlFiles, the driver replaces CDP, and a page that
fails to load is a page_load_failed finding. The original counts one finding per theme, the port one per viewport;
pass/fail is what is compared.

### check-render — pass fixture

- original: exit=0 (pass=true)
- port:     ok=true findings=0
- note: viewports [390, 1280] are the port's default; themes are opt-in (the fixtures have no data-theme rules, so the original's three themes render identically); pages come from findHtmlFiles

```
  original> 
  original> http://127.0.0.1:35399/
  original> 
  original>   ok   12 renders checked (2 pages × 3 themes × 2 widths)
  original>   ok   no rendering findings
  original>   ok   nothing on the page is blocked by the production CSP
  original> 
  original> Every page renders in all three themes, at 390px and 1280px.
  port>     {"ok":true,"findingCount":0,"findings":[]}
```

### check-render — fail fixture (contrast)

- original: exit=1 (pass=false)
- port:     ok=false findings=2
- note: viewports [390, 1280] are the port's default; themes are opt-in (the fixtures have no data-theme rules, so the original's three themes render identically); pages come from findHtmlFiles

```
  original> 
  original> http://127.0.0.1:36483/
  original> 
  original>   ok   6 renders checked (1 pages × 3 themes × 2 widths)
  original> 
  original>   FAIL index.html [terminal @390px] contrast 1.61:1 (needs 4.5) p rgb(204, 204, 204) — "Faint text."
  original>   FAIL index.html [dark @390px] contrast 1.61:1 (needs 4.5) p rgb(204, 204, 204) — "Faint text."
  original>   FAIL index.html [light @390px] contrast 1.61:1 (needs 4.5) p rgb(204, 204, 204) — "Faint text."
  original>   FAIL index.html [terminal @1280px] contrast 1.61:1 (needs 4.5) p rgb(204, 204, 204) — "Faint text."
  original>   FAIL index.html [dark @1280px] contrast 1.61:1 (needs 4.5) p rgb(204, 204, 204) — "Faint text."
  original>   FAIL index.html [light @1280px] contrast 1.61:1 (needs 4.5) p rgb(204, 204, 204) — "Faint text."
  original>   FAIL no rendering findings
  original>        6 found
  original>   ok   nothing on the page is blocked by the production CSP
  original> 
  original> 1 failed: no rendering findings
  port>     {"ok":false,"findingCount":2,"findings":[{"path":"/","kind":"contrast","message":"contrast 1.61:1, needs 4.5:1","severity":"error","hint":"Pick a text or background colour that reaches the needed ratio.","viewport":390,"selector":"p"},{"path":"/","kind":"contrast","message":"contrast 1.61:1, needs 4.5:1","severity":"error","hint":"Pick a text or background colour that reaches the needed ratio.","viewport":1280,"selector":"p"}]}
```

### check-render — fail fixture (nav_label_wrapped)

- original: exit=1 (pass=false)
- port:     ok=false findings=2
- note: viewports [390, 1280] are the port's default; themes are opt-in (the fixtures have no data-theme rules, so the original's three themes render identically); pages come from findHtmlFiles

```
  original> 
  original> http://127.0.0.1:37869/
  original> 
  original>   ok   6 renders checked (1 pages × 3 themes × 2 widths)
  original> 
  original>   FAIL index.html [terminal @390px] nav label breaks mid-phrase: "How it ships" across 2 lines
  original>   FAIL index.html [dark @390px] nav label breaks mid-phrase: "How it ships" across 2 lines
  original>   FAIL index.html [light @390px] nav label breaks mid-phrase: "How it ships" across 2 lines
  original>   FAIL index.html [terminal @1280px] nav label breaks mid-phrase: "How it ships" across 2 lines
  original>   FAIL index.html [dark @1280px] nav label breaks mid-phrase: "How it ships" across 2 lines
  original>   FAIL index.html [light @1280px] nav label breaks mid-phrase: "How it ships" across 2 lines
  original>   FAIL no rendering findings
  original>        6 found
  original>   ok   nothing on the page is blocked by the production CSP
  original> 
  original> 1 failed: no rendering findings
  port>     {"ok":false,"findingCount":2,"findings":[{"path":"/","kind":"nav_label_wrapped","message":"nav label breaks across lines: \"How it ships\"","severity":"error","hint":"Shorten the label or widen its slot.","viewport":390,"selector":".nav-links a"},{"path":"/","kind":"nav_label_wrapped","message":"nav label breaks across lines: \"How it ships\"","severity":"error","hint":"Shorten the label or widen its slot.","viewport":1280,"selector":".nav-links a"}]}
```

### check-render — fail fixture (overflow)

- original: exit=1 (pass=false)
- port:     ok=false findings=2
- note: viewports [390, 1280] are the port's default; themes are opt-in (the fixtures have no data-theme rules, so the original's three themes render identically); pages come from findHtmlFiles

```
  original> 
  original> http://127.0.0.1:44803/
  original> 
  original>   ok   6 renders checked (1 pages × 3 themes × 2 widths)
  original> 
  original>   FAIL index.html [terminal @1280px] scrolls sideways: div reaches 1500px in a 1280px viewport
  original>   FAIL index.html [dark @1280px] scrolls sideways: div reaches 1500px in a 1280px viewport
  original>   FAIL index.html [light @1280px] scrolls sideways: div reaches 1500px in a 1280px viewport
  original>   FAIL no rendering findings
  original>        3 found
  original>   ok   nothing on the page is blocked by the production CSP
  original> 
  original> 1 failed: no rendering findings
  port>     {"ok":false,"findingCount":2,"findings":[{"path":"/","kind":"overflow","message":"scrolls sideways: reaches 1500px in a 390px viewport","severity":"error","hint":"Constrain this element's width, or let it scroll inside its own container.","viewport":390,"selector":"div"},{"path":"/","kind":"overflow","message":"scrolls sideways: reaches 1500px in a 1280px viewport","severity":"error","hint":"Constrain this element's width, or let it scroll inside its own container.","viewport":1280,"selector":"div"}]}
```

### check-render — fail fixture (unpainted)

- original: exit=1 (pass=false)
- port:     ok=false findings=2
- note: viewports [390, 1280] are the port's default; themes are opt-in (the fixtures have no data-theme rules, so the original's three themes render identically); pages come from findHtmlFiles

```
  original> 
  original> http://127.0.0.1:36359/
  original> 
  original>   ok   6 renders checked (1 pages × 3 themes × 2 widths)
  original> 
  original>   FAIL index.html [terminal @390px] body has no opaque background
  original>   FAIL index.html [dark @390px] body has no opaque background
  original>   FAIL index.html [light @390px] body has no opaque background
  original>   FAIL index.html [terminal @1280px] body has no opaque background
  original>   FAIL index.html [dark @1280px] body has no opaque background
  original>   FAIL index.html [light @1280px] body has no opaque background
  original>   FAIL no rendering findings
  original>        6 found
  original>   ok   nothing on the page is blocked by the production CSP
  original> 
  original> 1 failed: no rendering findings
  port>     {"ok":false,"findingCount":2,"findings":[{"path":"/","kind":"unpainted","message":"body has no opaque background","severity":"error","hint":"Give body or html a background-colour.","viewport":390},{"path":"/","kind":"unpainted","message":"body has no opaque background","severity":"error","hint":"Give body or html a background-colour.","viewport":1280}]}
```

### check-a11y-structure — pass fixture

- original: exit=0 (pass=true)
- port:     ok=true findings=0

```
  original> 
  original> http://127.0.0.1:43137/
  original> 
  original>   ok   about.html loads
  original>   ok   index.html loads
  original>   ok   2 pages have sound heading order, landmarks and labels
  original>   ok   nothing on the page is blocked by the production CSP
  original> 
  original> Structure is sound across 2 pages.
  port>     {"ok":true,"findingCount":0,"findings":[]}
```

### check-a11y-structure — fail fixture (alt_is_filename)

- original: exit=1 (pass=false)
- port:     ok=false findings=1

```
  original> 
  original> http://127.0.0.1:44239/
  original> 
  original>   ok   index.html loads
  original> 
  original>   FAIL index.html: alt text is a filename: logo.png
  original>   FAIL 1 pages have sound heading order, landmarks and labels
  original>        1 findings
  original>   ok   nothing on the page is blocked by the production CSP
  original> 
  original> 1 failed: 1 pages have sound heading order, landmarks and labels
  port>     {"ok":false,"findingCount":1,"findings":[{"path":"/","kind":"alt_is_filename","message":"alt text is a file name: \"logo.png\"","severity":"error","hint":"Describe the image in the alt text instead of repeating its file name.","selector":"img"}]}
```

### check-a11y-structure — fail fixture (h1_count)

- original: exit=1 (pass=false)
- port:     ok=false findings=1

```
  original> 
  original> http://127.0.0.1:37441/
  original> 
  original>   ok   index.html loads
  original> 
  original>   FAIL index.html: has 2 h1 elements
  original>   FAIL 1 pages have sound heading order, landmarks and labels
  original>        1 findings
  original>   ok   nothing on the page is blocked by the production CSP
  original> 
  original> 1 failed: 1 pages have sound heading order, landmarks and labels
  port>     {"ok":false,"findingCount":1,"findings":[{"path":"/","kind":"h1_count","message":"has 2 h1 elements, expected 1","severity":"error","hint":"Give the page exactly one <h1>.","selector":"h1"}]}
```

### check-a11y-structure — fail fixture (heading_jump)

- original: exit=1 (pass=false)
- port:     ok=false findings=1

```
  original> 
  original> http://127.0.0.1:43893/
  original> 
  original>   ok   index.html loads
  original> 
  original>   FAIL index.html: heading jumps h1 to h3 at "Skipped a level"
  original>   FAIL 1 pages have sound heading order, landmarks and labels
  original>        1 findings
  original>   ok   nothing on the page is blocked by the production CSP
  original> 
  original> 1 failed: 1 pages have sound heading order, landmarks and labels
  port>     {"ok":false,"findingCount":1,"findings":[{"path":"/","kind":"heading_jump","message":"jumps from h1 to h3 at \"Skipped a level\"","severity":"error","hint":"Do not skip a heading level; add the missing level or change this one.","selector":"h3"}]}
```

### check-a11y-structure — fail fixture (img_missing_alt)

- original: exit=1 (pass=false)
- port:     ok=false findings=1

```
  original> 
  original> http://127.0.0.1:40451/
  original> 
  original>   ok   index.html loads
  original> 
  original>   FAIL index.html: image with no alt: ta:image/gif;base64,R0lGODlhAQABAAAAACw=
  original>   FAIL 1 pages have sound heading order, landmarks and labels
  original>        1 findings
  original>   ok   nothing on the page is blocked by the production CSP
  original> 
  original> 1 failed: 1 pages have sound heading order, landmarks and labels
  port>     {"ok":false,"findingCount":1,"findings":[{"path":"/","kind":"img_missing_alt","message":"image with no alt: data:image/gif;base64,R0lGODlhAQABAAAAACw=","severity":"error","hint":"Add an alt attribute; use alt=\"\" if the image is decoration.","selector":"img"}]}
```

### check-a11y-structure — fail fixture (missing_main)

- original: exit=1 (pass=false)
- port:     ok=false findings=1

```
  original> 
  original> http://127.0.0.1:43463/
  original> 
  original>   ok   index.html loads
  original> 
  original>   FAIL index.html: no <main>
  original>   FAIL 1 pages have sound heading order, landmarks and labels
  original>        1 findings
  original>   ok   nothing on the page is blocked by the production CSP
  original> 
  original> 1 failed: 1 pages have sound heading order, landmarks and labels
  port>     {"ok":false,"findingCount":1,"findings":[{"path":"/","kind":"missing_main","message":"no <main> landmark","severity":"error","hint":"Wrap the page's main content in <main>.","selector":"main"}]}
```

### check-a11y-structure — fail fixture (missing_nav)

- original: exit=1 (pass=false)
- port:     ok=false findings=1

```
  original> 
  original> http://127.0.0.1:45491/
  original> 
  original>   ok   index.html loads
  original> 
  original>   FAIL index.html: no <nav>
  original>   FAIL 1 pages have sound heading order, landmarks and labels
  original>        1 findings
  original>   ok   nothing on the page is blocked by the production CSP
  original> 
  original> 1 failed: 1 pages have sound heading order, landmarks and labels
  port>     {"ok":false,"findingCount":1,"findings":[{"path":"/","kind":"missing_nav","message":"no <nav> landmark","severity":"error","hint":"Wrap the site navigation links in <nav>.","selector":"nav"}]}
```

### check-a11y-structure — fail fixture (skip_link_target_missing)

- original: exit=1 (pass=false)
- port:     ok=false findings=1

```
  original> 
  original> http://127.0.0.1:32973/
  original> 
  original>   ok   index.html loads
  original> 
  original>   FAIL index.html: the skip link points at nothing
  original>   FAIL 1 pages have sound heading order, landmarks and labels
  original>        1 findings
  original>   ok   nothing on the page is blocked by the production CSP
  original> 
  original> 1 failed: 1 pages have sound heading order, landmarks and labels
  port>     {"ok":false,"findingCount":1,"findings":[{"path":"/","kind":"skip_link_target_missing","message":"the skip link points at nothing","severity":"error","hint":"Point the skip link at an element that exists, e.g. <main id=\"main\">.","selector":"a.skip-link"}]}
```

### check-a11y-structure — fail fixture (unlabelled_control)

- original: exit=1 (pass=false)
- port:     ok=false findings=1

```
  original> 
  original> http://127.0.0.1:35705/
  original> 
  original>   ok   index.html loads
  original> 
  original>   FAIL index.html: unlabelled button
  original>   FAIL 1 pages have sound heading order, landmarks and labels
  original>        1 findings
  original>   ok   nothing on the page is blocked by the production CSP
  original> 
  original> 1 failed: 1 pages have sound heading order, landmarks and labels
  port>     {"ok":false,"findingCount":1,"findings":[{"path":"/","kind":"unlabelled_control","message":"a control has no accessible name","severity":"error","hint":"Give this control visible text or an aria-label.","selector":"button"}]}
```

## Browser checks (check-motion, check-degrade)

| check | parity | reason |
|---|---|---|
| check-motion | rewrite, no parity run | The original walks five fixed pages of one live site and shares a CDP session with a focus-ring check the port does not carry; the port sweeps every rendered page against a served directory, so there is no like-for-like input to run both on. |
| check-degrade | rewrite, no parity run | The original needs a running API and a hard-coded table of eight pages with per-page selectors; the port checks the text of `<main>` on every page with `/api/*` blocked, so the two decide different things. |

---

**Summary**: 9 of 10 ported checks run against the real original tool
above (24 scenarios, at least a pass and a fail fixture per check).
0 pass/fail mismatch(es). 1 check (check-redaction) not run — see above.
