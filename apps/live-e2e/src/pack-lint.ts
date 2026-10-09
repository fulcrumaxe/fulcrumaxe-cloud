/**
 * Pack lint: pack code reaches the app only through the fixtures (`page`, `context`, `api`, `anon`) and the
 * shared client, because those are the paths the bypass rule and the write fence cover. A pack that makes a
 * request any other way would send around both, so the lint refuses the ways to do it: its own request context,
 * `fetch` in any spelling, `XMLHttpRequest`, the Node network and process stacks, a hand-made browser context,
 * the built-in `request` fixture and any `.request.` member (which covers `page.context().request.post(...)`,
 * the likeliest careless route: Playwright's `APIRequestContext` is not seen by `context.route`).
 *
 * Two more routes are closed by name: `createClient` (a pack-built client has its own fence config, or none, and
 * the fixtures' `api` and `anon` are the only clients wired to the run's target) and any import or `require` of
 * `@playwright/test` (its `test` is the unfenced one; packs take `test` and `expect` from the fixtures module, and
 * a type-only import is fine).
 *
 * It reads the whole source text with comments stripped (so a call split across lines is still seen), which makes
 * it a tripwire for the obvious routes, not a proof. The control for browser traffic is the fence in the context;
 * for Node-side traffic it is the lint plus the `fetch` guard the fixtures install (`installFetchGuard`).
 * `route.fetch(` is allowed: it is the fence's own mechanism and only runs inside a request a route handler holds.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface LintFinding {
  file: string;
  line: number;
  rule: string;
}

/** Modules that open a network connection or a process of their own. */
const STACKS = ["https?", "http2", "net", "tls", "child_process", "undici", "axios", "node-fetch", "ws"].join("|");

/** Each rule is run against the comment-stripped whole text and returns the offsets of the offending text. */
const RULES: { rule: string; offsets: (text: string) => number[] }[] = [
  { rule: "request.newContext", offsets: (t) => matchAll(t, /\brequest\s*\.\s*newContext\b/g) },
  { rule: "fetch(", offsets: (t) => matchAll(t, /(?<![\w.$])fetch\s*\(/g) },
  { rule: "globalThis.fetch / window.fetch / self.fetch", offsets: (t) => matchAll(t, /\b(?:globalThis|window|self)\s*\.\s*fetch\b/g) },
  {
    rule: ".fetch( on anything but route",
    offsets: (t) => matchAll(t, /\.\s*fetch\s*\(/g, (m) => !/(?:^|[^\w$.])route\s*$/.test(t.slice(0, m.index))),
  },
  { rule: "createClient", offsets: (t) => matchAll(t, /\bcreateClient\b/g) },
  {
    rule: "@playwright/test import (use the fenced test fixture)",
    offsets: (t) => [
      ...matchAll(t, /\b(?:import|export)\s+(?!type\b)[^;"']*?\bfrom\s*["']@playwright\/test(?:\/[^"']*)?["']/g),
      ...matchAll(t, /\bimport\s*["']@playwright\/test(?:\/[^"']*)?["']/g),
      ...matchAll(t, /\b(?:require|import)\s*\(\s*["']@playwright\/test(?:\/[^"']*)?["']\s*\)/g),
    ],
  },
  { rule: "XMLHttpRequest", offsets: (t) => matchAll(t, /\bXMLHttpRequest\b/g) },
  { rule: "import of a network or process stack", offsets: (t) => matchAll(t, new RegExp(`(?:from|import|require)\\s*\\(?\\s*["'](?:node:)?(?:${STACKS})(?:/[^"']*)?["']`, "g")) },
  { rule: "browser.newContext / newPage", offsets: (t) => matchAll(t, /\.\s*newContext\s*\(|\bbrowser\s*\.\s*newPage\s*\(/g) },
  { rule: "own browser launch", offsets: (t) => matchAll(t, /\.\s*(?:launch|launchPersistentContext|connectOverCDP)\s*\(/g) },
  { rule: "built-in request fixture", offsets: (t) => matchAll(t, /async\s*\(\s*\{[^}]*\brequest\b[^}]*\}/g) },
  { rule: ".request. member (page.context().request, page.request, context.request)", offsets: (t) => matchAll(t, /\.\s*request\s*\./g) },
  { rule: "page.request / context.request", offsets: (t) => matchAll(t, /\b(?:page|context)\s*\.\s*request\b/g) },
];

function matchAll(text: string, pattern: RegExp, keep: (m: RegExpExecArray) => boolean = () => true): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(pattern)) if (keep(m as RegExpExecArray)) out.push(m.index);
  return out;
}

/** Removes block comments and whole-line `//` comments, keeping line numbers. */
export function stripComments(text: string): string {
  const blanked = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return blanked
    .split("\n")
    .map((l) => (l.trimStart().startsWith("//") ? "" : l))
    .join("\n");
}

export function lintSource(file: string, text: string): LintFinding[] {
  const stripped = stripComments(text);
  const seen = new Set<string>();
  const out: LintFinding[] = [];
  for (const { rule, offsets } of RULES) {
    for (const offset of offsets(stripped)) {
      const line = stripped.slice(0, offset).split("\n").length;
      const key = `${line}:${rule}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ file, line, rule });
      }
    }
  }
  return out.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(?:[cm]?[jt]sx?)$/.test(entry)) out.push(full);
  }
  return out.sort();
}

/** Lints every script under `packsDir` (specs and helpers alike). */
export function lintPacks(packsDir: string): LintFinding[] {
  return sourceFiles(packsDir).flatMap((f) => lintSource(relative(packsDir, f), readFileSync(f, "utf8")));
}
