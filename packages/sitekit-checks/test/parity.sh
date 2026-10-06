#!/usr/bin/env bash
# Parity check for D#2606 K02: for each ported mechanical check, run the
# ORIGINAL os-site-v2/tools/<check>.py|.mjs against a fixture and run this
# package's TypeScript port against the equivalent fixture, then compare
# pass/fail. Requires python3 and node locally (nix develop in this repo
# provides both). Makes no network calls.
#
# Usage: bash test/parity.sh   (from anywhere; paths are self-relative)
# Set ORIGINAL_TOOLS_DIR to the os-site-v2/tools checkout (it has no default).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURES="$PKG_DIR/test/fixtures"
ORIGINAL_TOOLS_DIR="${ORIGINAL_TOOLS_DIR:-}"

HARNESS="$(mktemp -d -t sitekit-checks-parity-K02.XXXXXX)"
trap 'rm -rf "$HARNESS"' EXIT

mismatches=0
scenarios=0

# Copy one original source file, unmodified, into the harness. Uses a plain
# read + redirect rather than `cp`, since the source is outside this repo.
copy_original() {
  cat "$ORIGINAL_TOOLS_DIR/$1" > "$HARNESS/orig-tools/$1"
}

mkdir -p "$HARNESS/orig-tools"
if [ ! -d "$ORIGINAL_TOOLS_DIR" ]; then
  echo "ORIGINAL_TOOLS_DIR (${ORIGINAL_TOOLS_DIR:-unset}) is not a directory — cannot run parity." >&2
  echo "Set ORIGINAL_TOOLS_DIR to the os-site-v2/tools checkout." >&2
  exit 2
fi
copy_original sitepages.py
copy_original build-i18n.py
copy_original check-links.py
copy_original check-meta.py
copy_original check-nojs.py
copy_original check-weight.py
copy_original check-i18n-catalogue.py
copy_original check-i18n-chrome.py
copy_original check-a11y.py
copy_original check-headers.py
copy_original check-freshness.py

# ---------------------------------------------------------------------------
# Runs one scenario: original tool (python3) vs. this package's TS port.
# Sets globals ORIG_EXIT, ORIG_OUT, TS_JSON — not `local` return values,
# because both outputs can be multi-line and there is no delimiter safe to
# thread through a single command-substitution string.
#
# $1 = check name (matches a CHECKS key in src/index.ts and the original's
#      base filename), $2 = fixture dir, $3 = extra original CLI args,
# $4 = TS options JSON (omit for {}),
# $5 = contents for formal-support/vercel.json (check-headers' original reads its config there).
# ---------------------------------------------------------------------------
run_scenario() {
  local check="$1" fixture_dir="$2" orig_args="${3:-}" ts_options="${4:-}" vercel_json="${5:-}"

  rm -rf "$HARNESS/formal-support"
  mkdir -p "$HARNESS/formal-support"
  cp -r "$fixture_dir/." "$HARNESS/formal-support/"
  if [ -n "$vercel_json" ]; then
    printf '%s' "$vercel_json" > "$HARNESS/formal-support/vercel.json"
  fi

  ORIG_OUT=$(cd "$PKG_DIR" && python3 "$HARNESS/orig-tools/$check.py" $orig_args 2>&1)
  ORIG_EXIT=$?

  TS_JSON=$(cd "$PKG_DIR" && pnpm exec tsx test/parity-run.ts "$check" "$HARNESS/formal-support" "$ts_options" 2>&1)
}

report() {
  local title="$1" note="${2:-}"
  scenarios=$((scenarios + 1))
  local ts_ok ts_findings
  ts_ok=$(node -e "try{const r=JSON.parse(process.argv[1]);process.stdout.write(String(r.ok))}catch(e){process.stdout.write('PARSE_ERROR')}" "$TS_JSON")
  ts_findings=$(node -e "try{const r=JSON.parse(process.argv[1]);process.stdout.write(String(r.findingCount))}catch(e){process.stdout.write('?')}" "$TS_JSON")

  local orig_pass=false
  [ "$ORIG_EXIT" -eq 0 ] && orig_pass=true

  {
    echo ""
    echo "### $title"
    echo ""
    echo "- original: exit=$ORIG_EXIT (pass=$orig_pass)"
    echo "- port:     ok=$ts_ok findings=$ts_findings"
    if [ -n "$note" ]; then
      echo "- note: $note"
    fi
    echo ""
    echo '```'
    echo "$ORIG_OUT" | sed 's/^/  original> /'
    echo "$TS_JSON" | sed 's/^/  port>     /'
    echo '```'
  } >> "$OUT_FILE"

  if [ "$orig_pass" != "$ts_ok" ]; then
    echo "" >> "$OUT_FILE"
    echo "MISMATCH: original pass=$orig_pass but port ok=$ts_ok" >> "$OUT_FILE"
    mismatches=$((mismatches + 1))
  fi
}

OUT_FILE="$HARNESS/report.md"
{
echo "# Parity report — D#2606 K02"
echo ""
echo "Generated $(date -u +%Y-%m-%dT%H:%M:%SZ) by test/parity.sh against"
echo "the directory named by \`ORIGINAL_TOOLS_DIR\` (read-only, unmodified — copied into a scratch"
echo "harness so each original tool's own \`SITE = HERE/../formal-support\`"
echo "resolves to this run's fixture instead of the real os-site-v2 site)."
echo ""
echo "For each check: the SAME fixture content is run through the original"
echo "tool and through the TypeScript port, and their pass/fail is compared"
echo "(the number that gates this script's exit code). Finding counts are"
echo "also printed for a reader to check, but are not diffed automatically —"
echo "the original prints prose lines per finding while the port returns"
echo "structured Finding objects, and they are not always 1:1 countable (see"
echo "check-i18n-chrome's note below, and the check-links note on advisory"
echo "findings the original does not have a concept of)."
echo ""
} > "$OUT_FILE"

# --- check-links -------------------------------------------------------------
run_scenario check-links "$FIXTURES/check-links/fail"
report "check-links — fail fixture"

run_scenario check-links "$FIXTURES/check-links/pass"
report "check-links — pass fixture" \
  "the port additionally reports an advisory (non-failing) external_needs_review finding for the fixture's example.com link — K02 item 4, which the original tool does not check at all"

# --- check-meta ----------------------------------------------------------------
run_scenario check-meta "$FIXTURES/check-meta/fail"
report "check-meta — fail fixture"

run_scenario check-meta "$FIXTURES/check-meta/pass"
report "check-meta — pass fixture"

# --- check-nojs ------------------------------------------------------------------
run_scenario check-nojs "$FIXTURES/check-nojs/fail"
report "check-nojs — fail fixture"

run_scenario check-nojs "$FIXTURES/check-nojs/pass"
report "check-nojs — pass fixture"

# --- check-weight -----------------------------------------------------------------
run_scenario check-weight "$FIXTURES/check-weight/fail"
report "check-weight — fail fixture"

run_scenario check-weight "$FIXTURES/check-weight/pass"
report "check-weight — pass fixture"

# --- check-i18n-catalogue --------------------------------------------------------
run_scenario check-i18n-catalogue "$FIXTURES/check-i18n-catalogue/fail" "es index.html"
report "check-i18n-catalogue — fail fixture"

run_scenario check-i18n-catalogue "$FIXTURES/check-i18n-catalogue/pass" "es index.html"
report "check-i18n-catalogue — pass fixture"

# --- check-i18n-chrome -------------------------------------------------------------
# The original hardcodes two extra always-wanted labels ("Keyboard shortcuts",
# "Language") harvested from its own fixed nav script. The port takes the
# wanted label set as an explicit parameter instead — the correct
# generalization for a multi-tenant site kit with no fixed nav script — so
# this comparison uses a dedicated parity fixture
# (test/fixtures/check-i18n-chrome/parity/) whose chrome.json translates all
# four, isolating the mechanical missing/extra logic the two implementations
# actually share.
CHROME_TS_OPTS='{"wantedLabels":["Learn more","Sign in","Keyboard shortcuts","Language"]}'

run_chrome_scenario() {
  local scenario_dir="$1"
  rm -rf "$HARNESS/formal-support"
  mkdir -p "$HARNESS/formal-support/i18n"
  cp -r "$scenario_dir/i18n/." "$HARNESS/formal-support/i18n/"
  cat "$FIXTURES/check-i18n-chrome/parity/sync-nav.mjs" > "$HARNESS/orig-tools/sync-nav.mjs"

  ORIG_OUT=$(cd "$PKG_DIR" && python3 "$HARNESS/orig-tools/check-i18n-chrome.py" 2>&1)
  ORIG_EXIT=$?
  TS_JSON=$(cd "$PKG_DIR" && pnpm exec tsx test/parity-run.ts check-i18n-chrome "$HARNESS/formal-support" "$CHROME_TS_OPTS" 2>&1)
}

run_chrome_scenario "$FIXTURES/check-i18n-chrome/parity/fail"
report "check-i18n-chrome — fail fixture" \
  "run against test/fixtures/check-i18n-chrome/parity/ (not the unit-test fixture), which also translates the original's two hardcoded convenience labels — see comment above"

run_chrome_scenario "$FIXTURES/check-i18n-chrome/parity/pass"
report "check-i18n-chrome — pass fixture"

# --- check-a11y --------------------------------------------------------------------
# The original exempts locked.html / 404.html by basename; the port takes page paths.
A11Y_EXEMPT_OPTS='{"h1ExemptPaths":["/locked.html"],"skipLinkExemptPaths":["/404.html","/locked.html"]}'
run_scenario check-a11y "$FIXTURES/check-a11y/pass"
report "check-a11y — pass fixture"
run_scenario check-a11y "$FIXTURES/check-a11y/exempt" "" "$A11Y_EXEMPT_OPTS"
report "check-a11y — exemptions fixture" "locked.html exemption passed as options"
for rule in img_missing_alt h1_count html_missing_lang input_missing_label missing_skip_link; do
  run_scenario check-a11y "$FIXTURES/check-a11y/fail/$rule"
  report "check-a11y — fail fixture ($rule)"
done

# --- check-headers -----------------------------------------------------------------
# The original reads formal-support/vercel.json; the port takes the SAME rules as options.headers.
CACHE_CC='{"key":"Cache-Control","value":"public, max-age=3600"}'
HEADERS_PASS="[{\"source\":\"/search-index.json\",\"headers\":[$CACHE_CC]},{\"source\":\"/feed.xml\",\"headers\":[$CACHE_CC]}]"
HEADERS_FAIL="[{\"source\":\"/search-index.json\",\"headers\":[$CACHE_CC]}]"
run_scenario check-headers "$FIXTURES/check-headers/pass" "" "{\"headers\":$HEADERS_PASS}" "{\"headers\":$HEADERS_PASS}"
report "check-headers — pass fixture" "options.headers replaces reading vercel.json"
run_scenario check-headers "$FIXTURES/check-headers/fail" "" "{\"headers\":$HEADERS_FAIL}" "{\"headers\":$HEADERS_FAIL}"
report "check-headers — fail fixture" "options.headers replaces reading vercel.json"

# --- check-freshness ---------------------------------------------------------------
# The original reads the real clock and five fixed sidecar paths, so these
# fixtures are generated relative to now (a committed dated fixture would flip
# verdict over time) and the port gets the same five sidecars as options.
FRESH_SIDECARS='[{"path":"history/stats.json","timestampKey":"generatedAt","maxAgeDays":14},{"path":"code-metrics.json","maxAgeDays":30},{"path":"apps.json","maxAgeDays":30},{"path":"understand/knowledge-graph.json","timestampKey":"project.analyzedAt","maxAgeDays":45},{"path":"feed.xml","maxAgeDays":21}]'
FRESH_OPTS="{\"sidecars\":$FRESH_SIDECARS}"

# $1 = dir, $2 = days old for history/stats.json, $3 = days until security.txt expires (omit for none)
make_fresh_fixture() {
  local dir="$1" stats_age="$2" txt_days="${3:-}"
  rm -rf "$dir"
  mkdir -p "$dir/history" "$dir/understand" "$dir/.well-known"
  printf '{"generatedAt":"%s"}' "$(date -u -d "$stats_age days ago" +%Y-%m-%dT%H:%M:%SZ)" > "$dir/history/stats.json"
  printf '{"project":{"analyzedAt":"%s"}}' "$(date -u -d "1 day ago" +%Y-%m-%dT%H:%M:%SZ)" > "$dir/understand/knowledge-graph.json"
  printf '{}' > "$dir/code-metrics.json"
  printf '{}' > "$dir/apps.json"
  printf '<rss/>' > "$dir/feed.xml"
  if [ -n "$txt_days" ]; then
    printf 'Contact: mailto:security@example.com\nExpires: %s\n' "$(date -u -d "$txt_days days" +%Y-%m-%dT%H:%M:%SZ)" > "$dir/.well-known/security.txt"
  fi
}

make_fresh_fixture "$HARNESS/fresh-pass" 1 365
run_scenario check-freshness "$HARNESS/fresh-pass" "" "$FRESH_OPTS"
report "check-freshness — pass fixture" \
  "the three sidecars with no declared timestamp pass the original on file mtime; the port gives an advisory sidecar_age_undeclared (ok stays true) — deliberate divergence"
make_fresh_fixture "$HARNESS/fresh-stale" 100 365
run_scenario check-freshness "$HARNESS/fresh-stale" "" "$FRESH_OPTS"
report "check-freshness — fail fixture (stale sidecar)"
make_fresh_fixture "$HARNESS/fresh-txt" 1 10
run_scenario check-freshness "$HARNESS/fresh-txt" "" "$FRESH_OPTS"
report "check-freshness — fail fixture (security.txt expiring in 10 days)"

# --- browser checks: check-render, check-a11y-structure ---------------------------
# The originals drive Chrome over a TCP debugging port (--remote-debugging-port) and read
# ../formal-support (flat *.html files), so the fixture is copied there and served by serve.ts, never by
# the originals' devserver.mjs (not copied). BASE must already answer, so ensureSite() starts nothing.
# CHROME is the first Chromium that accepts --headless=new; without one the section is SKIPPED (exit 0).
# Manual run on committed fixtures only: an open debugging port is not acceptable anywhere else.
BROWSER_STATUS="SKIPPED (no Chromium accepting --headless=new)"
accepts_headless_new() {
  local home; home="$(mktemp -d -p "$HARNESS")"
  HOME="$home" timeout 30 "$1" --headless=new --dump-dom about:blank 2>/dev/null | grep -q "<html"
}
PARITY_CHROME=""
for candidate in "${CHROME:-}" "${PLAYWRIGHT_BROWSERS_PATH:-/nonexistent}"/chromium-*/chrome-linux*/chrome; do
  if [ -n "$candidate" ] && [ -x "$candidate" ] && accepts_headless_new "$candidate"; then PARITY_CHROME="$candidate"; break; fi
done

run_browser_scenario() {
  local check="$1" fixture_dir="$2" ts_options="${3:-}"
  rm -rf "$HARNESS/formal-support"; mkdir -p "$HARNESS/formal-support"
  cp -r "$fixture_dir/." "$HARNESS/formal-support/"
  (cd "$PKG_DIR" && exec node --import tsx test/browser/parity-serve.ts "$HARNESS/formal-support") > "$HARNESS/serve.out" 2>&1 &
  local serve_pid=$! base="" home; home="$(mktemp -d -p "$HARNESS")"
  for _ in $(seq 1 100); do base="$(head -1 "$HARNESS/serve.out")"; [ -n "$base" ] && break; sleep 0.1; done
  if node -e 'fetch(process.argv[1]+"/").then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))' "$base"; then
    ORIG_OUT=$(cd "$HARNESS/orig-tools" && BASE="$base" CHROME="$PARITY_CHROME" HOME="$home" timeout 300 node "$check.mjs" 2>&1)
    ORIG_EXIT=$?
  else
    ORIG_OUT="BASE ($base) did not answer; the original was not run"; ORIG_EXIT=99
  fi
  kill "$serve_pid" 2>/dev/null; wait "$serve_pid" 2>/dev/null
  TS_JSON=$(cd "$PKG_DIR" && node --import tsx test/browser/parity-run.ts "$check" "$HARNESS/formal-support" "$ts_options" 2>&1)
}

if [ -n "$PARITY_CHROME" ]; then
  BROWSER_STATUS="ran with CHROME=$PARITY_CHROME"
  for tool in check-render check-a11y-structure browser; do
    copy_original "$tool.mjs"
  done
  NOTE="viewports [390, 1280] are the port's default; themes are opt-in (the fixtures have no data-theme rules, so the original's three themes render identically); pages come from findHtmlFiles"
  run_browser_scenario check-render "$FIXTURES/check-render/pass"
  report "check-render — pass fixture" "$NOTE"
  for kind in $(ls "$FIXTURES/check-render/fail"); do
    run_browser_scenario check-render "$FIXTURES/check-render/fail/$kind"
    report "check-render — fail fixture ($kind)" "$NOTE"
  done
  run_browser_scenario check-a11y-structure "$FIXTURES/check-a11y-structure/pass"
  report "check-a11y-structure — pass fixture"
  for kind in $(ls "$FIXTURES/check-a11y-structure/fail"); do
    run_browser_scenario check-a11y-structure "$FIXTURES/check-a11y-structure/fail/$kind"
    report "check-a11y-structure — fail fixture ($kind)"
  done
else
  echo "SKIPPED browser parity: $BROWSER_STATUS"
fi

# --- check-redaction: NOT RUN ------------------------------------------------------
{
echo ""
echo "### check-redaction — NOT RUN"
echo ""
echo "os-site-v2/tools/check-redaction.mjs imports \`../formal-support/api/*.js\`"
echo "and \`lib/github.js\`, and its main body makes a live GitHub GraphQL call"
echo "(\`graphql(PR_QUERY, ...)\`) unconditionally — there is no flag to skip it."
echo "That call needs \`GITHUB_TOKEN\` and network access to api.github.com,"
echo "neither of which this harness has (K02's own pnpm test suite must make"
echo "zero network calls, and this parity run inherits that constraint rather"
echo "than reaching out to a live API from an unattended script)."
echo ""
echo "Not marked matched. What WAS verified by hand: this port's"
echo "\`GENERIC_LEAK_PATTERNS\` and \`GENERIC_LEAK_PLANTS\` (src/checks/redaction.ts)"
echo "reproduce the original's \`LEAKS\`/\`PLANTS\` self-test pairs for the"
echo "categories that do not name this deployment's own private strings"
echo "(absolute home path, email address, GitHub token, OpenAI-style key, AWS"
echo "access key, 40+ char hex blob, plus a private-key-block and JWT pattern"
echo "the original does not have). The per-site deny-list — hosts, account"
echo "names, email patterns — is this port's own addition (K02 item 3: the"
echo "original hardcodes its own org's private strings, which cannot work for"
echo "a multi-tenant kit); it has no original counterpart to diff against, and"
echo "is instead covered by this package's own vitest suite"
echo "(test/checks/redaction.test.ts), including the B5 shape (a private"
echo "GitHub account and a private host) with invented placeholder names."
} >> "$OUT_FILE"

{
echo ""
echo "---"
echo ""
echo "**Summary**: every ported check except check-redaction runs against the real original tool"
echo "above ($scenarios scenarios, at least a pass and a fail fixture per check)."
echo "Browser section (check-render, check-a11y-structure): $BROWSER_STATUS."
echo "$mismatches pass/fail mismatch(es). 1 check (check-redaction) not run — see above."
} >> "$OUT_FILE"

cat "$OUT_FILE"

if [ "$mismatches" -gt 0 ]; then
  exit 1
fi
exit 0
