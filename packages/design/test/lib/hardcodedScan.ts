import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * D#2 spec amendment pass/fail item 3: fails when any surface hardcodes a
 * colour or a spacing value instead of using a token.
 *
 * Scans `.css`/`.ts`/`.tsx` source files (never `.json` — that's where a
 * token *file* is allowed, in fact required, to hold a literal value) for:
 *   - hex colours (#fff, #a7ffcb, #00ff6640, ...)
 *   - rgb(/rgba(/hsl(/hsla( literals
 *   - raw px/rem lengths
 *
 * Narrow documented allowlist: a bare `0` length (`0px`/`0rem`), and `1px`
 * (hairline borders — a border width that variable-driven theming has no
 * reason to touch). `100%` is never matched in the first place, since this
 * scanner only targets the px/rem units, not percentages.
 */

export interface Violation {
  file: string;
  line: number;
  kind: "hex-color" | "color-function" | "raw-length";
  snippet: string;
}

const SCANNED_EXTENSIONS = new Set([".css", ".ts", ".tsx"]);
// D#37 WS-C2 fix round item 6 (should-fix, S1): narrowed from "skip any
// directory literally named _generated" to this one exact file. The
// broad directory-name skip would have silently exempted anything else
// a future PR ever placed under a same-named _generated/ directory
// anywhere in the scanned trees, not just this one committed dump --
// see the comment below (moved from the old directory-skip site) for
// why THIS file specifically needs the exemption.
const GENERATED_EXEMPT_FILE = path.join("apps", "web", "app", "_generated", "workspace-index.ts");
// Negative lookbehind excludes "D#2606"-style Discussion references: a real
// CSS hex colour is never immediately preceded by a word character (a
// property value starts after whitespace, a colon, `(`, or line start).
const HEX_RE = /(?<![\w])#[0-9a-fA-F]{3,8}\b/g;
const COLOR_FN_RE = /\b(rgb|rgba|hsl|hsla)\s*\(/gi;
const LENGTH_RE = /\b(\d+(?:\.\d+)?)(px|rem)\b/g;

function isAllowedLength(raw: string, value: number): boolean {
  if (value === 0) return true; // bare 0, with or without a unit
  if (raw === "1px") return true; // hairline borders
  return false;
}

async function listFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // directory doesn't exist yet (e.g. a surface not yet created) — nothing to scan
  }
  const out: string[] = [];
  for (const entry of entries) {
    // "out" skips gitignored build output (e.g. a site build's out/, left
    // on disk by a prior build run): it's generated, not
    // authored, so it's not a surface this guard is meant to police, and
    // scanning it makes the repo-wide `pnpm test` depend on build-then-test
    // ordering instead of passing regardless of what's on disk.
    //
    if (entry.name === "node_modules" || entry.name === "fixtures" || entry.name === "out")
      continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFiles(full)));
    } else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      // D#37 WS-C2's apps/web/app/_generated/workspace-index.ts: a
      // committed-but-regenerated dump of the fulcrumaxe workspace's OWN
      // index.html (third-party markup, re-imported verbatim -- see D#37
      // correction C7's identical reasoning for excluding
      // apps/workspace/shell/** from the repo's ESLint config), which
      // legitimately contains "#9660"/"#10005"-shaped numeric HTML
      // character references (e.g. `&#9660;`) that this scanner's
      // hex-colour regex cannot tell apart from a real hardcoded colour
      // without parsing HTML. Exempting the exact file (not the whole
      // directory name, wherever it recurs) keeps every other file --
      // including any future one that happens to live under a
      // same-named _generated/ directory elsewhere -- fully scanned.
      if (full.endsWith(GENERATED_EXEMPT_FILE)) continue;
      out.push(full);
    }
  }
  return out;
}

/** Scans every file under `dirs` (directories that don't exist are skipped,
 * not an error) and returns every hardcoded-value violation found. */
export async function scanForHardcodedValues(dirs: readonly string[]): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const dir of dirs) {
    const files = await listFiles(dir);
    for (const file of files) {
      const text = await fs.readFile(file, "utf-8");
      const lines = text.split("\n");
      lines.forEach((lineText, idx) => {
        for (const m of lineText.matchAll(HEX_RE)) {
          violations.push({ file, line: idx + 1, kind: "hex-color", snippet: m[0] });
        }
        for (const m of lineText.matchAll(COLOR_FN_RE)) {
          violations.push({ file, line: idx + 1, kind: "color-function", snippet: m[0] });
        }
        for (const m of lineText.matchAll(LENGTH_RE)) {
          if (!isAllowedLength(m[0], Number(m[1]))) {
            violations.push({ file, line: idx + 1, kind: "raw-length", snippet: m[0] });
          }
        }
      });
    }
  }
  return violations;
}
