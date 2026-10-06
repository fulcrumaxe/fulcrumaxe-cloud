#!/usr/bin/env node
// Expand-and-contract migration lint.
//
// A deploy rollback (promoting the previous deployment) only works if the OLD
// code still runs on the NEW schema. So a new migration may add and widen, but
// may not take away or reshape anything the previous deploy depends on:
//
//   drop-column     ALTER TABLE ... DROP [COLUMN] x
//   drop-table      DROP TABLE x
//   drop-view       DROP [MATERIALIZED] VIEW x
//   drop-schema     DROP SCHEMA x
//   drop-type       DROP TYPE x
//   drop-function   DROP FUNCTION / PROCEDURE x, unless the same file re-creates it
//   rename          any RENAME (table, column, constraint, ...)
//   set-schema      SET SCHEMA (a move works like a rename)
//   alter-type      ALTER TABLE ... ALTER [COLUMN] x [SET DATA] TYPE t
//   not-null        ADD COLUMN ... NOT NULL with no DEFAULT / GENERATED, or
//                   ALTER COLUMN x SET NOT NULL (old code may still write NULL)
//   truncate        TRUNCATE
//
// Not seen (documented gap): SQL built as a string and run with EXECUTE.
//
// A migration that must do one of these (the "contract" phase) says so with a
// `--` comment on its own line naming the earlier expand step:
//
//   -- contract-phase: D#454        (also  #123  or  PR #123)
//
// Only a real line comment counts: one inside a /* */ block, a string literal or
// a dollar-quoted body (a function body or DO block) is text, not a marker. A
// marker with no reference does not count.
//
// Modes
//   (default)  check migration files this branch added, modified or renamed
//              against the base (same base rule as check-migration-order.sh:
//              MIGRATION_ORDER_BASE, else origin/main; exit 2 if unresolvable).
//              The baseline is NOT applied: an edit to an old file is linted.
//   --all      check every migration on disk, skipping BASELINE.
//   --no-baseline  with --all: ignore the baseline and list everything.
//
// Existing migrations that predate the lint and trip a rule are listed in
// BASELINE below, by file name. The list may only shrink: a test fails when a
// baselined file no longer trips any rule.
//
// Exit codes: 0 clean, 1 violation, 2 could not run (bad base, bad argument).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MIGRATIONS_DIR = "packages/db/migrations";

/** Files that predate this lint. Filled in from `--all --no-baseline`. */
export const BASELINE = [
  "0639_stream_leases.sql", // SET NOT NULL after a backfill and a default in the same file
  "0695_onboarding_preview_install_limit.sql", // SET NOT NULL on backfilled columns
  "0683_run_action_list_due.sql", // DROP FUNCTION run_action_claim_due, replaced by a differently named function
];

const MARKER_BODY = /^[ \t]*contract-phase:(.*)$/i;
// A reference to the earlier expand step: D#123, #123 or PR #123 / PR 123.
const MARKER_REF = /^\s*(?:D#\d+|#\d+|PR\s*#?\d+)(?![\w#])/i;
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Split SQL into code and markers. Comments and string contents are blanked
 * out of `code`; quoted identifiers keep their text (as `q_<text>`) so two
 * different names stay different. Dollar-quoted bodies stay in `code` on
 * purpose (a DO block runs its statements). `markers` holds the text after
 * `--` for line comments that start their line outside any dollar-quoted body.
 */
export function stripNoise(sql) {
  let code = "";
  const markers = [];
  let dollar = null; // closing tag while inside a dollar-quoted body
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (dollar) {
      if (sql.startsWith(dollar, i)) {
        code += dollar;
        i += dollar.length;
        dollar = null;
        continue;
      }
    } else if (c === "$") {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 64));
      if (tag) {
        dollar = tag[0];
        code += tag[0];
        i += tag[0].length;
        continue;
      }
    }
    if (c === "-" && next === "-") {
      const lineStart = sql.lastIndexOf("\n", i - 1) + 1;
      const ownLine = /^[ \t]*$/.test(sql.slice(lineStart, i));
      let j = i + 2;
      while (j < sql.length && sql[j] !== "\n") j += 1;
      if (ownLine && !dollar) markers.push(sql.slice(i + 2, j));
      i = j;
    } else if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      code += " ";
    } else if (c === "'" || c === '"') {
      const quote = c;
      // E'...' strings treat backslash as an escape.
      const escapes = quote === "'" && /[eE]/.test(sql[i - 1] ?? "") && !/\w/.test(sql[i - 2] ?? " ");
      let text = "";
      i += 1;
      while (i < sql.length) {
        if (escapes && sql[i] === "\\") {
          i += 2;
        } else if (sql[i] === quote && sql[i + 1] === quote) {
          text += quote;
          i += 2;
        } else if (sql[i] === quote) break;
        else {
          text += sql[i];
          i += 1;
        }
      }
      i += 1;
      code += quote === '"' ? ` q_${text.replace(/\W/g, "_")} ` : " ";
    } else {
      code += c;
      i += 1;
    }
  }
  return { code, markers };
}

/** Split on commas that are not inside parentheses. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
const bare = (name) => name.replace(/^public\./, "");

/** Returns [{ rule, snippet }] for one migration's text, honouring the marker. */
export function checkSql(sqlText) {
  const { code, markers } = stripNoise(sqlText);
  const goodMarker = markers.some((m) => {
    const body = MARKER_BODY.exec(m);
    return body !== null && MARKER_REF.test(body[1]);
  });
  const found = [];
  const lowerCode = code.toLowerCase();
  const created = new Set(
    [...lowerCode.matchAll(/\bcreate\s+(?:unlogged\s+|temp(?:orary)?\s+)?table\s+(?:if\s+not\s+exists\s+)?([\w."]+)/g)].map((m) => bare(m[1])),
  );
  const recreated = new Set(
    [...lowerCode.matchAll(/\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure)\s+([\w."]+)/g)].map((m) => bare(m[1])),
  );

  for (const raw of code.split(";")) {
    const stmt = norm(raw);
    if (!stmt) continue;
    const snippet = stmt.slice(0, 90);
    const hit = (rule) => found.push({ rule, snippet });
    if (/\bdrop\s+table\b/.test(stmt)) hit("drop-table");
    if (/\bdrop\s+(?:materialized\s+)?view\b/.test(stmt)) hit("drop-view");
    if (/\bdrop\s+schema\b/.test(stmt)) hit("drop-schema");
    if (/\bdrop\s+type\b/.test(stmt)) hit("drop-type");
    if (/\brename\b/.test(stmt)) hit("rename");
    if (/\bset\s+schema\b/.test(stmt)) hit("set-schema");
    if (/\btruncate\b/.test(stmt)) hit("truncate");
    for (const m of stmt.matchAll(/\bdrop\s+(?:function|procedure)\s+(?:if\s+exists\s+)?([\w."]+)/g)) {
      if (!recreated.has(bare(m[1]))) hit("drop-function");
    }
    const alter = /\balter\s+table\s+(?:(?:only|if\s+exists)\s+)*([\w."]+)\s+(.*)$/.exec(stmt);
    if (!alter) continue;
    const isNewTable = created.has(bare(alter[1]));
    for (const action of splitTopLevel(alter[2])) {
      if (/^drop\s+(?:column\s+)?(?:if\s+exists\s+)?(?!constraint\b)\S/.test(action)) hit("drop-column");
      if (/^alter\s+(?:column\s+)?\S+\s+(?:set\s+data\s+)?type\b/.test(action)) hit("alter-type");
      if (isNewTable) continue; // old code cannot be writing a table that did not exist
      if (/^alter\s+(?:column\s+)?\S+\s+set\s+not\s+null\b/.test(action)) hit("not-null");
      if (
        /^add\s+(?!constraint\b|check\b|primary\b|unique\b|foreign\b|exclude\b)/.test(action) &&
        /\bnot\s+null\b/.test(action) &&
        !/\b(default|generated)\b/.test(action)
      ) {
        hit("not-null");
      }
    }
  }

  if (goodMarker) return [];
  const seen = new Set();
  return found.filter((f) => {
    const key = `${f.rule}|${f.snippet}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function touchedMigrations(root, baseRef) {
  let mergeBase;
  try {
    mergeBase = git(["merge-base", "HEAD", baseRef], root).trim();
  } catch {
    return { error: `cannot resolve base ${baseRef} - refusing to pass` };
  }
  const out = git(["diff", "--name-only", "--diff-filter=AMR", mergeBase, "HEAD", "--", MIGRATIONS_DIR], root);
  return { files: out.split("\n").filter((f) => f.endsWith(".sql")).map((f) => path.basename(f)) };
}

export function run(argv, env = process.env, cwd = process.cwd()) {
  const lines = [];
  let all = false;
  let useBaseline = true;
  let baseRef = env.MIGRATION_ORDER_BASE || "origin/main";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--all") all = true;
    else if (argv[i] === "--no-baseline") useBaseline = false;
    else if (argv[i] === "--base" && argv[i + 1]) baseRef = argv[++i];
    else return { code: 2, lines: [`migration-compat: unknown argument: ${argv[i]}`] };
  }
  let root;
  try {
    root = git(["rev-parse", "--show-toplevel"], cwd).trim();
  } catch {
    return { code: 2, lines: ["migration-compat: not inside a git checkout"] };
  }
  let names;
  if (all) {
    names = readdirSync(path.join(root, MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"));
  } else {
    const t = touchedMigrations(root, baseRef);
    if (t.error) return { code: 2, lines: [`migration-compat: ${t.error}`] };
    names = t.files;
    useBaseline = false; // a change to any migration, old or new, is linted in full
  }
  let bad = 0;
  for (const name of names.sort()) {
    if (all && useBaseline && BASELINE.includes(name)) continue;
    const text = readFileSync(path.join(root, MIGRATIONS_DIR, name), "utf8");
    const hits = checkSql(text);
    if (hits.length === 0) continue;
    bad += 1;
    for (const h of hits) lines.push(`${MIGRATIONS_DIR}/${name}: ${h.rule}: ${h.snippet}`);
  }
  if (bad > 0) {
    lines.push(
      "migration-compat: a migration may add and widen but not remove or reshape. Split it into an expand",
      "migration now and a contract migration later, or, for the contract migration, add a line",
      "  -- contract-phase: <D#n | #n | PR #n>",
      "naming the earlier expand step. See docs/ops/runbooks/rollback.md.",
    );
    return { code: 1, lines };
  }
  lines.push(`migration-compat: ${names.length} migration file(s) checked, none break the previous deploy`);
  return { code: 0, lines };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, lines } = run(process.argv.slice(2));
  for (const l of lines) (code === 0 ? console.log : console.error)(l);
  process.exit(code);
}
