#!/usr/bin/env bash
# scripts/check-agent-run-columns.sh -- keep star selects off agent_runs.
#
# app_user may SELECT only an explicit column list on agent_runs (migration
# 0756): a column added later, such as the report tag and key reference the
# outside-meter work adds, is ungranted until it is listed. A star select over
# that table therefore fails at run time with SQLSTATE 42501 -- and a role that
# does hold the wide grant would hand those columns to a route by accident.
# This scan fails the build before either happens.
#
# It reads every string literal (backtick, single or double quote) in the
# .ts/.tsx/.mts/.cts/.js/.mjs/.cjs files under --root (default: this repo),
# and fails when a literal that names agent_runs has:
#   1. `agent_runs.*`                       (qualified star)
#   2. `<alias>.*` where <alias> is an alias the same statement gave
#      agent_runs (`FROM agent_runs r` ... `r.*`), including a mixed list such
#      as `SELECT w.id, r.* FROM work_items w JOIN agent_runs r ...`
#   3. a bare `*` select-list item, or `RETURNING *`, in a statement whose own
#      FROM / JOIN / UPDATE / INSERT INTO / DELETE FROM names agent_runs
#      (a star over a join counts; count(*) does not).
# A subquery is judged on its own FROM, so `SELECT * FROM work_items WHERE
# EXISTS (SELECT 1 FROM agent_runs ...)` is clean.
#
# A statement that runs as a privileged role (never app_user) may carry the
# SQL comment /* agent-run-columns: allow <reason> */ inside the literal.
#
# Limits: it sees one literal at a time, so SQL assembled from several string
# pieces is not reconstructed; .sql files (migrations, definers) are not read.
#
# Usage: bash scripts/check-agent-run-columns.sh [--root DIR]
# Exit 0 = clean. Exit 1 = at least one hit (file:line: rule). Exit 2 = usage.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$here"
if [ "${1:-}" = "--root" ]; then
  [ -n "${2:-}" ] || { echo "check-agent-run-columns: --root needs a directory" >&2; exit 2; }
  root="$2"
  shift 2
fi
[ "$#" -eq 0 ] || { echo "usage: check-agent-run-columns.sh [--root DIR]" >&2; exit 2; }
[ -d "$root" ] || { echo "check-agent-run-columns: no such directory: $root" >&2; exit 2; }

exec node --input-type=module - "$root" <<'JS'
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2]);
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '.git', '.turbo', 'migrations', 'archive', '.claude', '.autonomous-team']);
// The scan's own fixtures hold the shapes it must catch.
const SKIP_FILES = new Set(['agent-run-columns-scan.test.ts']);
const EXT = /\.(?:[cm]?[jt]s|tsx)$/;
const ALLOW = /agent-run-columns:\s*allow/i;
const ALIAS_STOP = new Set([
  'where', 'join', 'on', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'using', 'set', 'group',
  'order', 'limit', 'for', 'lateral', 'returning', 'union', 'except', 'intersect', 'offset', 'fetch',
  'window', 'tablesample', 'as', 'values', 'select', 'from', 'having', 'outer', 'with', 'and', 'or',
]);

function listFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) listFiles(full, out);
    else if (EXT.test(name) && !name.endsWith('.d.ts') && !SKIP_FILES.has(name)) out.push(full);
  }
  return out;
}

// Every string literal in `src` as { text, line }. ${...} is replaced by a
// placeholder so its parentheses cannot confuse the depth count. Comments are
// skipped so a doc comment that mentions a star select is not a hit.
function literals(src) {
  const out = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const startLine = line;
      let text = '';
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') { text += src[i + 1] ?? ''; if (src[i + 1] === '\n') line++; i += 2; continue; }
        if (c === '`' && src[i] === '$' && src[i + 1] === '{') {
          let depth = 1;
          i += 2;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            else if (src[i] === '\n') line++;
            i++;
          }
          text += ' X ';
          continue;
        }
        if (src[i] === '\n') { line++; if (c !== '`') break; }
        text += src[i];
        i++;
      }
      i++;
      out.push({ text, line: startLine });
      continue;
    }
    i++;
  }
  return out;
}

const NAME = String.raw`(?:"?public"?\.)?"?agent_runs"?`;
const MENTION = new RegExp(String.raw`\b${NAME}(?![\w])`, 'i');

// `s` with everything inside a parenthesis deeper than `level` blanked out.
function maskDeeper(s, level) {
  let depth = 0;
  let out = '';
  for (const ch of s) {
    if (ch === '(') { depth++; out += depth > level ? ' ' : ch; continue; }
    if (ch === ')') { out += depth > level ? ' ' : ch; depth--; continue; }
    out += depth > level ? ' ' : ch;
  }
  return out;
}

function aliasesOf(text) {
  const names = new Set(['agent_runs']);
  const re = new RegExp(String.raw`(?:\bfrom|\bjoin|\bupdate|\busing|,)\s+(?:only\s+)?${NAME}(?:\s+(?:as\s+)?([a-z_]\w*))?`, 'gi');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const a = m[1]?.toLowerCase();
    if (a && !ALIAS_STOP.has(a)) names.add(a);
  }
  return names;
}

function check(text) {
  if (ALLOW.test(text)) return [];
  if (!MENTION.test(text)) return [];
  const flat = text.replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();
  const hits = [];
  for (const a of aliasesOf(flat)) {
    if (new RegExp(String.raw`(?<![\w.])"?${a}"?\s*\.\s*\*`, 'i').test(flat)) {
      hits.push(a === 'agent_runs' ? 'agent_runs.* (qualified star)' : `${a}.* (alias of agent_runs)`);
    }
  }
  // RETURNING * on a write whose target is agent_runs.
  const write = new RegExp(String.raw`\b(?:update|insert\s+into|delete\s+from)\s+(?:only\s+)?${NAME}(?![\w])`, 'i');
  if (write.test(flat) && /\breturning\s+(?:[^;]*,\s*)?\*(?![\w(])/i.test(flat)) {
    hits.push('RETURNING * on agent_runs');
  }
  // A bare star in a select list whose own FROM / JOIN names agent_runs.
  const sel = /\bselect\b/gi;
  for (let m = sel.exec(flat); m; m = sel.exec(flat)) {
    const start = m.index + m[0].length;
    let depth = 0;
    let fromAt = -1;
    let end = flat.length;
    for (let k = start; k < flat.length; k++) {
      const ch = flat[k];
      if (ch === '(') depth++;
      else if (ch === ')') { if (depth === 0) { end = k; break; } depth--; }
      else if (ch === ';' && depth === 0) { end = k; break; }
      else if (depth === 0 && fromAt < 0 && lower.startsWith('from', k) && !/\w/.test(flat[k - 1] ?? ' ') && !/\w/.test(flat[k + 4] ?? ' ')) fromAt = k;
    }
    if (fromAt < 0) continue;
    const list = maskDeeper(flat.slice(start, fromAt), 0).replace(/\b\w+\s*\(\s*\*\s*\)/g, ' ');
    const clause = maskDeeper(flat.slice(fromAt, end), 0);
    if (!MENTION.test(clause)) continue;
    if (/^\s*(?:distinct\s+(?:on\s*\([^)]*\)\s*)?)?\*\s*(?:,|$)|,\s*\*\s*(?:,|$)/i.test(list)) {
      hits.push('bare * select over agent_runs');
    }
  }
  return hits;
}

const failures = [];
for (const file of listFiles(root)) {
  const src = readFileSync(file, 'utf8');
  for (const lit of literals(src)) {
    for (const why of check(lit.text)) {
      failures.push(`${path.relative(root, file)}:${lit.line}: ${why}`);
    }
  }
}

if (failures.length > 0) {
  console.error('check-agent-run-columns: a star select over agent_runs (app_user holds a column list, 0756):');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('check-agent-run-columns: ok');
JS
