import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A pure static scan with no database access -- shaped after
// packages/decisions/test/importScan.test.ts and packages/gh-policy/test/
// importScan.test.ts's own tree-walking guards.
//
// D#97 (D#76 correction C3, from PR #91's security review, should-fix 1):
// rewritten from a per-LINE regex scan to a whole-FILE identifier scan.
// The old per-line `/\s+audit_log/` missed `INSERT INTO public.audit_log`
// (no leading whitespace before `public`), `FROM "audit_log"` (quoted),
// a statement split across two lines (`INSERT INTO\n  audit_log (x)`),
// and skipped the `.cjs`, `.cts`, `.mts`, `.jsx` and `.sql` extensions
// outright. This version:
//
//   1. Strips comments first (`//`, `/* */`, and SQL `--` in `.sql`
//      files) so a comment MENTIONING audit_log doesn't false-positive --
//      but ONLY when the comment opener begins its line (nothing but
//      whitespace precedes it). D#97 fix round 1 (CWE-184): an earlier
//      version of this stripper tracked quote-char state instead, and a
//      single stray quote that didn't actually open a string -- a JSX
//      apostrophe, a regex literal, a quoted SQL identifier -- was
//      enough to desynchronize that tracking and blank out a REAL, later
//      `audit_log` reference as if it were inside a string or comment,
//      silently defeating the guard. Only ever stripping an unambiguous,
//      line-leading comment removes that failure mode: nothing mid-line
//      is ever blanked, so a mis-tracked quote can no longer hide
//      anything. The trade is a one-directional false positive instead
//      -- a genuine TRAILING comment that mentions `audit_log`
//      (`SELECT 1; -- see audit_log`) is left un-stripped and gets
//      flagged, fixed by rewording the comment. That is the only kind of
//      mistake this stripper can make now; it can never cause a real,
//      non-commented `audit_log` reference to be missed.
//   2. Flags any bare `audit_log` identifier, matched case-insensitively
//      across line breaks, optionally schema-qualified
//      (`public.`/`"public".`) and/or double-quoted on either side --
//      regardless of which SQL keyword (if any) precedes it.
//   3. Scans `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`
//      and `.sql` files under `packages/*/src/**` and
//      `apps/*/{app,src,lib}/**`.
//
// A concatenated or interpolated table name cannot be caught statically
// -- `"audit" + "_log"`, or `${table}` where `table` resolves to
// `'audit_log'` only at runtime, both defeat this (or any) static scan.
// The database grants (`REVOKE INSERT ON audit_log FROM app_user`,
// 0008_audit_log_append_only.sql) are the real control; this scan is a
// second, best-effort layer that catches every syntactic form the #91
// review listed, not a guarantee against a determined bypass.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const SCANNED_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|sql)$/;
const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'dist', '.next', 'test', '__tests__']);

/**
 * D#97 decision (d): a bare `audit_log` identifier, optionally
 * schema-qualified (`public.`/`"public".`, either side optionally
 * double-quoted), matched case-insensitively. `\s*` already matches
 * newlines, so a schema-qualifier split across a line break (or
 * `INSERT INTO\n  audit_log`, once the keyword prefix is irrelevant to
 * this pattern) is still caught. The lookbehind/lookahead pair keeps
 * this from matching a LONGER identifier that merely contains
 * `audit_log` as a substring (`audit_logger`, `my_audit_log`).
 */
const AUDIT_LOG_IDENTIFIER_RE = /(?<![A-Za-z0-9_$])(?:"?public"?\s*\.\s*)?"?audit_log"?(?![A-Za-z0-9_$])/gi;

/**
 * D#69 moved the ledger `packages/billing/src/idempotency.ts` used to
 * read/write to its own platform_ops-only table (`stripe_webhook_events`,
 * migration 0606) and archived the file
 * (archive/billing-idempotency-2026-09-18/), so the allowlist is now
 * empty. Do not add any entry without a Discussion explaining why the
 * static scan can't be satisfied another way -- this is meant to stay
 * empty.
 */
const ALLOWLIST: readonly string[] = [];

function safeSubdirs(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SCANNED_EXT_RE.test(entry.name)) continue;
    if (entry.name.includes('.test.')) continue;
    out.push(path.join(dir, entry.name));
  }
}

/** Every scanned-extension file under each package's `src` directory, and each app's `app`, `src`, or `lib` directory, below `root`. */
function listScannedFiles(root: string): string[] {
  const out: string[] = [];
  const packagesDir = path.join(root, 'packages');
  for (const pkg of safeSubdirs(packagesDir)) {
    walk(path.join(packagesDir, pkg, 'src'), out);
  }
  const appsDir = path.join(root, 'apps');
  for (const app of safeSubdirs(appsDir)) {
    for (const sub of ['app', 'src', 'lib']) {
      walk(path.join(appsDir, app, sub), out);
    }
  }
  return out;
}

/**
 * Strips `--` line comments in a `.sql` file, but ONLY when the `--`
 * begins its line (nothing but whitespace precedes it on that line).
 * Each stripped character is replaced with a space (the newline itself
 * is preserved) so line numbers in the caller's later scan stay aligned
 * with the original file. D#97 fix round 1 (CWE-184): this used to track
 * `'...'` string-literal state instead and strip any `--` outside a
 * tracked string, anywhere on the line -- a single unmatched quote (a
 * quoted identifier like `"it's"`, or SQL's own `''` doubled-quote
 * escape) desynchronized that tracking and could blank a REAL
 * `audit_log` reference later in the file. A `--` that doesn't begin its
 * line (inside a string literal, or a genuine trailing comment) is now
 * left as code and scanned like anything else: at worst a trailing
 * comment that mentions `audit_log` gets flagged and needs rewording --
 * it can never cause a real reference to be missed.
 */
function stripSqlComments(text: string): string {
  let out = '';
  let i = 0;
  let lineStart = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '\n') {
      out += c;
      i++;
      lineStart = i;
      continue;
    }
    if (c === '-' && text[i + 1] === '-' && /^[ \t]*$/.test(text.slice(lineStart, i))) {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Strips `//` line comments and `/* *\/` block comments in a JS/TS-family
 * file, but ONLY when the comment opener (`//` or `/*`) begins its line
 * (nothing but whitespace precedes it on that line). Same line-number-
 * preserving replacement strategy as {@link stripSqlComments}. D#97 fix
 * round 1 (CWE-184): this used to track `'...'`, `"..."` and `` `...` ``
 * string-literal state instead and strip any `//`/`/* *\/` outside a
 * tracked string, anywhere on the line -- a single unmatched quote (a
 * JSX apostrophe in `<p>Don't panic</p>`, a regex literal like `/"/`)
 * desynchronized that tracking, and everything after it -- including a
 * REAL, later `audit_log` reference -- got treated as still "inside a
 * string" or blanked as a comment. A `//` or `/*` that doesn't begin its
 * line (inside a string, a regex, JSX text, or a genuine trailing
 * comment) is now left as code and scanned like anything else: at worst
 * a trailing comment that mentions `audit_log` gets flagged and needs
 * rewording -- it can never cause a real reference to be missed. Known
 * limitation, unchanged from before: a template literal's `${...}`
 * interpolation is scanned as ordinary text (an `audit_log` reference
 * inside one is still caught), but this stripper has no special handling
 * for it beyond that.
 */
function stripJsComments(text: string): string {
  let out = '';
  let i = 0;
  let lineStart = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '\n') {
      out += c;
      i++;
      lineStart = i;
      continue;
    }
    const atLineStart = /^[ \t]*$/.test(text.slice(lineStart, i));
    if (atLineStart && c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (atLineStart && c === '/' && text[i + 1] === '*') {
      out += '  ';
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') {
          out += '\n';
          i++;
          lineStart = i;
        } else {
          out += ' ';
          i++;
        }
      }
      if (i < text.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function stripComments(text: string, filename: string): string {
  return filename.endsWith('.sql') ? stripSqlComments(text) : stripJsComments(text);
}

export interface AuditLogViolation {
  file: string;
  line: number;
  text: string;
}

/** Exported so the deliberate-failure fixtures below can exercise it directly, against any root. */
export function scanForAuditLogAccess(root: string, allowlist: readonly string[]): AuditLogViolation[] {
  const violations: AuditLogViolation[] = [];
  for (const file of listScannedFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (allowlist.includes(relative)) continue;
    const original = readFileSync(file, 'utf8');
    const stripped = stripComments(original, file);
    const originalLines = original.split('\n');

    AUDIT_LOG_IDENTIFIER_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    const flaggedLines = new Set<number>();
    while ((match = AUDIT_LOG_IDENTIFIER_RE.exec(stripped)) !== null) {
      const upto = stripped.slice(0, match.index);
      const line = upto.split('\n').length; // 1-indexed
      if (flaggedLines.has(line)) continue; // one violation entry per line, same as before
      flaggedLines.add(line);
      violations.push({ file: relative, line, text: (originalLines[line - 1] ?? '').trim() });
    }
  }
  return violations;
}

describe('audit-log-guard: no production code reads or raw-writes audit_log (D#76 criterion 10, D#97 hardening)', () => {
  it('ALLOWLIST has 0 entries, or exactly 1 entry equal to packages/billing/src/idempotency.ts', () => {
    const isValid =
      ALLOWLIST.length === 0 ||
      (ALLOWLIST.length === 1 && ALLOWLIST[0] === 'packages/billing/src/idempotency.ts');
    expect(isValid).toBe(true);
  });

  it('finds zero violations across the real tree', () => {
    const violations = scanForAuditLogAccess(REPO_ROOT, ALLOWLIST);
    expect(violations).toEqual([]);
  });

  it('deliberate-failure fixture: flags a planted "SELECT 1 FROM audit_log", in a throwaway tmp tree -- never the real one', () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'fx-audit-guard-'));
    try {
      const srcDir = path.join(tmpRoot, 'packages', 'fixture-pkg', 'src');
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(path.join(srcDir, 'planted.ts'), 'export const q = "SELECT 1 FROM audit_log";\n');

      const violations = scanForAuditLogAccess(tmpRoot, []);
      expect(violations).not.toEqual([]);
      expect(violations.some((v) => v.file === 'packages/fixture-pkg/src/planted.ts')).toBe(true);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('deliberate-failure fixture: also flags JOIN/INTO/UPDATE forms, case-insensitively', () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'fx-audit-guard-'));
    try {
      const srcDir = path.join(tmpRoot, 'apps', 'fixture-app', 'lib');
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(
        path.join(srcDir, 'planted.ts'),
        [
          'const a = "... join audit_log ...";',
          'const b = "insert into audit_log (x) values (1)";',
          'const c = "update AUDIT_LOG set x = 1";',
        ].join('\n'),
      );

      const violations = scanForAuditLogAccess(tmpRoot, []);
      expect(violations.length).toBe(3);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('does not flag a file that is on the allowlist', () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'fx-audit-guard-'));
    try {
      const srcDir = path.join(tmpRoot, 'packages', 'billing', 'src');
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(path.join(srcDir, 'idempotency.ts'), 'export const q = "SELECT 1 FROM audit_log";\n');

      const violations = scanForAuditLogAccess(tmpRoot, ['packages/billing/src/idempotency.ts']);
      expect(violations).toEqual([]);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('does not scan node_modules, dist, .next, test, __tests__, or *.test.* files', () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'fx-audit-guard-'));
    try {
      const cases: Array<[string, string]> = [
        [path.join('packages', 'p', 'src', 'node_modules', 'dep', 'index.ts'), 'FROM audit_log'],
        [path.join('packages', 'p', 'src', 'dist', 'built.js'), 'FROM audit_log'],
        [path.join('apps', 'a', 'app', '.next', 'gen.js'), 'FROM audit_log'],
        [path.join('packages', 'p', 'src', 'test', 'helper.ts'), 'FROM audit_log'],
        [path.join('packages', 'p', 'src', '__tests__', 'helper.ts'), 'FROM audit_log'],
        [path.join('packages', 'p', 'src', 'thing.test.ts'), 'FROM audit_log'],
      ];
      for (const [rel, content] of cases) {
        const full = path.join(tmpRoot, rel);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, `export const q = "${content}";\n`);
      }

      const violations = scanForAuditLogAccess(tmpRoot, []);
      expect(violations).toEqual([]);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('only scans packages/*/src/** and apps/*/{app,src,lib}/**, not e.g. packages/*/test/**', () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'fx-audit-guard-'));
    try {
      const outsideDir = path.join(tmpRoot, 'packages', 'p', 'scripts');
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(path.join(outsideDir, 'planted.ts'), 'export const q = "FROM audit_log";\n');

      const violations = scanForAuditLogAccess(tmpRoot, []);
      expect(violations).toEqual([]);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  describe('D#97: whole-file identifier scan catches every form the #91 review listed', () => {
    const cases: Array<[string, string]> = [
      ['INSERT INTO public.audit_log', 'INSERT INTO public.audit_log (x) VALUES (1);'],
      ['FROM "audit_log"', 'SELECT 1 FROM "audit_log";'],
      ['FROM "public"."audit_log"', 'SELECT 1 FROM "public"."audit_log";'],
      ['TABLE audit_log', 'TABLE audit_log;'],
      ['COPY audit_log TO STDOUT', 'COPY audit_log TO STDOUT;'],
      ['select * from AUDIT_LOG (case-insensitive)', 'select * from AUDIT_LOG;'],
    ];

    it.each(cases)('flags: %s', (_label, snippet) => {
      const tmpRoot = mkdtempSync(path.join(tmpdir(), 'fx-audit-guard-'));
      try {
        const srcDir = path.join(tmpRoot, 'packages', 'fixture-pkg', 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(path.join(srcDir, 'planted.ts'), `export const q = ${JSON.stringify(snippet)};\n`);

        const violations = scanForAuditLogAccess(tmpRoot, []);
        expect(violations.length).toBeGreaterThan(0);
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it('flags: INSERT INTO split across two REAL lines (a per-line scan would miss this)', () => {
      const tmpRoot = mkdtempSync(path.join(tmpdir(), 'fx-audit-guard-'));
      try {
        const srcDir = path.join(tmpRoot, 'packages', 'fixture-pkg', 'src');
        mkdirSync(srcDir, { recursive: true });
        // A genuine newline inside the template literal in the FILE's own
        // source text -- not an escaped "\n" inside a single-line string --
        // so "audit_log" starts a physical line with no keyword before it.
        writeFileSync(
          path.join(srcDir, 'planted.ts'),
          ['export const q = `INSERT INTO', '  audit_log (x) VALUES (1)`;', ''].join('\n'),
        );

        const violations = scanForAuditLogAccess(tmpRoot, []);
        expect(violations.length).toBeGreaterThan(0);
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    const extensionCases: Array<[string, string]> = [
      ['fixture.cjs', 'module.exports.q = "SELECT 1 FROM audit_log";\n'],
      ['fixture.cts', 'export const q: string = "SELECT 1 FROM audit_log";\n'],
      ['fixture.mts', 'export const q: string = "SELECT 1 FROM audit_log";\n'],
      ['fixture.jsx', 'export const q = "SELECT 1 FROM audit_log";\n'],
      ['fixture.sql', 'SELECT 1 FROM audit_log;\n'],
    ];

    it.each(extensionCases)('flags a violation in a %s file (previously an unscanned extension)', (filename, content) => {
      const tmpRoot = mkdtempSync(path.join(tmpdir(), 'fx-audit-guard-'));
      try {
        const srcDir = path.join(tmpRoot, 'packages', 'fixture-pkg', 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(path.join(srcDir, filename), content);

        const violations = scanForAuditLogAccess(tmpRoot, []);
        expect(violations.some((v) => v.file === `packages/fixture-pkg/src/${filename}`)).toBe(true);
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });
  });

  describe('D#97: comments do not false-positive, and audit_logger is not audit_log', () => {
    it('does not flag audit_log mentioned only in a // line comment', () => {
      const tmpRoot = mkdtempSync(path.join(tmpdir(), 'fx-audit-guard-'));
      try {
        const srcDir = path.join(tmpRoot, 'packages', 'fixture-pkg', 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(path.join(srcDir, 'planted.ts'), '// see audit_log for the ledger shape\nexport const x = 1;\n');

        expect(scanForAuditLogAccess(tmpRoot, [])).toEqual([]);
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it('does not flag audit_log mentioned only in a /* block comment */', () => {
      const tmpRoot = mkdtempSync(path.join(tmpdir(), 'fx-audit-guard-'));
      try {
        const srcDir = path.join(tmpRoot, 'packages', 'fixture-pkg', 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(path.join(srcDir, 'planted.ts'), '/* audit_log is evidence, never state */\nexport const x = 1;\n');

        expect(scanForAuditLogAccess(tmpRoot, [])).toEqual([]);
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it('does not flag audit_log mentioned only in a SQL -- comment', () => {
      const tmpRoot = mkdtempSync(path.join(tmpdir(), 'fx-audit-guard-'));
      try {
        const srcDir = path.join(tmpRoot, 'packages', 'fixture-pkg', 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(path.join(srcDir, 'planted.sql'), '-- audit_log is append-only\nSELECT 1;\n');

        expect(scanForAuditLogAccess(tmpRoot, [])).toEqual([]);
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it('does not flag the identifier audit_logger', () => {
      const tmpRoot = mkdtempSync(path.join(tmpdir(), 'fx-audit-guard-'));
      try {
        const srcDir = path.join(tmpRoot, 'packages', 'fixture-pkg', 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(path.join(srcDir, 'planted.ts'), 'export const audit_logger = createLogger();\n');

        expect(scanForAuditLogAccess(tmpRoot, [])).toEqual([]);
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it("a SQL string literal containing '--' is not treated as a comment opener (still flags audit_log later on the same line)", () => {
      const tmpRoot = mkdtempSync(path.join(tmpdir(), 'fx-audit-guard-'));
      try {
        const srcDir = path.join(tmpRoot, 'packages', 'fixture-pkg', 'src');
        mkdirSync(srcDir, { recursive: true });
        // A naive stripper that doesn't track string state would see the
        // "--" inside the quotes, blank out the rest of the line, and miss
        // "audit_log" that comes after the string closes.
        writeFileSync(path.join(srcDir, 'planted.sql'), "SELECT '--' AS marker, audit_log FROM t;\n");

        const violations = scanForAuditLogAccess(tmpRoot, []);
        expect(violations).not.toEqual([]);
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it("a '//' inside a TypeScript string literal is not treated as a comment opener (still flags audit_log after it on the same line)", () => {
      const tmpRoot = mkdtempSync(path.join(tmpdir(), 'fx-audit-guard-'));
      try {
        const srcDir = path.join(tmpRoot, 'packages', 'fixture-pkg', 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(
          path.join(srcDir, 'planted.ts'),
          'export const q = "https://example.test" + " FROM audit_log";\n',
        );

        const violations = scanForAuditLogAccess(tmpRoot, []);
        expect(violations).not.toEqual([]);
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });
  });

  describe('D#97 fix round 1 (CWE-184): a stray quote on one line must not blank a real reference elsewhere', () => {
    // Each of these reproduces a case the security review found: a quote
    // character that does not actually open a string (a JSX apostrophe, a
    // regex literal, a quoted SQL identifier) desynchronized the OLD
    // quote-tracking stripper, which then blanked a REAL `audit_log`
    // reference later in the file. Under the line-leading-only stripper
    // these fixtures must all still be flagged, because none of the
    // `//`, `/*` or `--` tokens involved begin their own line.
    const strayQuoteCases: Array<[string, string, string]> = [
      [
        "a JSX apostrophe, then a '/*'-shaped glob string, then a real FROM audit_log",
        'planted.tsx',
        ["<p>Don't panic</p>;", "const matcher = '/api/*';", "const q = 'SELECT actor FROM audit_log ...';", ''].join(
          '\n',
        ),
      ],
      [
        'a JSX apostrophe, then a real FROM audit_log built from a "//"-bearing URL string',
        'planted.tsx',
        ["<p>You're in</p>;", "const q = 'https://x' + ' FROM audit_log';", ''].join('\n'),
      ],
      [
        'a regex literal containing a quote, then a real FROM audit_log built from a "//"-bearing URL string',
        'planted.ts',
        ['const r = /"/;', 'const q = "https://x" + " FROM audit_log";', ''].join('\n'),
      ],
      [
        "a quoted SQL identifier containing an apostrophe, then a real FROM audit_log on the next line",
        'planted.sql',
        [`SELECT 1 AS "it's";`, `SELECT '--' || x, 1 FROM audit_log;`, ''].join('\n'),
      ],
    ];

    it.each(strayQuoteCases)('flags: %s', (_label, filename, content) => {
      const tmpRoot = mkdtempSync(path.join(tmpdir(), 'fx-audit-guard-'));
      try {
        const srcDir = path.join(tmpRoot, 'packages', 'fixture-pkg', 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(path.join(srcDir, filename), content);

        const violations = scanForAuditLogAccess(tmpRoot, []);
        expect(violations.length).toBeGreaterThan(0);
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });
  });
});
