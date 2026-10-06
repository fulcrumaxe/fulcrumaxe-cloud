import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FORBIDDEN_NAMES = new Set(['startAgentRun', 'cancelRun', 'runStatusWriter']);
const GH_PROXY = 'apps/web/app/api/gh-proxy/[...path]/';
/** The only value imports from @fx/runner that may exist (D#31 C33 s1): pure env-to-config helpers. */
const ALLOWLIST: Record<string, string[]> = {
  [`${GH_PROXY}handler.ts`]: ['githubProxyForwardUrl', 'loadGithubForwardConfig'],
  [`${GH_PROXY}route.ts`]: ['loadGithubForwardConfig'],
};

interface Found {
  spec: string;
  /** Names imported as values. */
  values: string[];
  /** Every imported name, type-qualified ones included. */
  names: string[];
  /** The whole module comes in as a value (namespace, side effect, import(), require()). */
  wholeModule: boolean;
}

/** Reads import specifiers from the TypeScript AST: static import, export-from, import() and require(). */
export function findImports(source: string): Found[] {
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Found[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const f: Found = { spec: node.moduleSpecifier.text, values: [], names: [], wholeModule: false };
      if (!clause) f.wholeModule = true;
      else {
        if (clause.name) {
          f.values.push('default');
          f.names.push('default');
        }
        const b = clause.namedBindings;
        if (b && ts.isNamespaceImport(b)) f.wholeModule = !clause.isTypeOnly;
        if (b && ts.isNamedImports(b)) {
          for (const el of b.elements) {
            const name = (el.propertyName ?? el.name).text;
            f.names.push(name);
            if (!clause.isTypeOnly && !el.isTypeOnly) f.values.push(name);
          }
        }
        if (clause.isTypeOnly) f.values = [];
      }
      found.push(f);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const f: Found = { spec: node.moduleSpecifier.text, values: [], names: [], wholeModule: false };
      if (!node.exportClause) f.wholeModule = !node.isTypeOnly;
      else if (ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          const name = (el.propertyName ?? el.name).text;
          f.names.push(name);
          if (!node.isTypeOnly && !el.isTypeOnly) f.values.push(name);
        }
      }
      found.push(f);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push({ spec: node.arguments[0].text, values: [], names: [], wholeModule: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const isRunnerSpec = (spec: string) => spec === '@fx/runner' || spec.startsWith('@fx/runner/');
const intoRunnerSrc = (spec: string) => spec.startsWith('.') && /(^|\/)packages\/runner\/|(^|\/)runner\/src\//.test(spec);

/** Violations for one file's source; `allowed` is that file's allowlisted value names. */
export function violations(source: string, allowed: string[] = []): string[] {
  const out: string[] = [];
  for (const f of findImports(source)) {
    for (const n of f.names) if (FORBIDDEN_NAMES.has(n)) out.push(`imports ${n} from ${f.spec}`);
    if (intoRunnerSrc(f.spec)) out.push(`relative import into runner: ${f.spec}`);
    if (isRunnerSpec(f.spec)) {
      if (f.wholeModule) out.push(`whole-module value import of ${f.spec}`);
      for (const v of f.values) if (!allowed.includes(v)) out.push(`value import ${v} from ${f.spec}`);
    }
  }
  return out;
}

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.next', 'dist', 'build', '.turbo'].includes(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(name)) out.push(full);
  }
  return out;
}

describe('D#2 C52 s5 criterion 5 / D#31 C33 s1: the request path does not reach the runner writers', () => {
  it('self-test: the checker sees what it should and ignores what it should', () => {
    expect(violations('import { startAgentRun } from "@fx/runner";')).not.toEqual([]);
    expect(violations('import { foo } from "@fx/runner";')).not.toEqual([]);
    expect(violations('import type { RunStatus } from "@fx/runner";')).toEqual([]);
    expect(violations('import { type RunStatus } from "@fx/runner";')).toEqual([]);
    expect(violations('export type { RunStatus } from "@fx/runner/statusTransitions";')).toEqual([]);
    expect(violations('// cancelRun\nconst a = "cancelRun"; const o = { operationId: "cancelRun" };')).toEqual([]);
    expect(violations('const m = await import("@fx/runner");')).not.toEqual([]);
    expect(violations('const m = require("@fx/runner");')).not.toEqual([]);
    expect(violations('import { cancelRun } from "../../runner/src/cancelRun.js";')).not.toEqual([]);
    expect(violations('import type { cancelRun } from "@fx/runner";')).not.toEqual([]);
    expect(violations('import { loadGithubForwardConfig } from "@fx/runner";', ['loadGithubForwardConfig'])).toEqual([]);
    expect(violations('import { other } from "@fx/runner";', ['loadGithubForwardConfig'])).not.toEqual([]);
  });

  const files = [...walk(path.join(REPO_ROOT, 'apps/web'), []), ...walk(path.join(REPO_ROOT, 'packages/api'), [])];

  it('walks a real set of files (not vacuous)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('no file under apps/web or packages/api breaks the rule', () => {
    const bad: string[] = [];
    for (const file of files) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
      for (const v of violations(readFileSync(file, 'utf8'), ALLOWLIST[rel])) bad.push(`${rel}: ${v}`);
    }
    expect(bad).toEqual([]);
  });

  it('every allowlist entry still matches a real value import (none goes stale)', () => {
    for (const [rel, names] of Object.entries(ALLOWLIST)) {
      const imported = findImports(readFileSync(path.join(REPO_ROOT, rel), 'utf8'))
        .filter((f) => isRunnerSpec(f.spec))
        .flatMap((f) => f.values);
      expect([...new Set(imported)].sort(), rel).toEqual([...names].sort());
    }
  });
});
