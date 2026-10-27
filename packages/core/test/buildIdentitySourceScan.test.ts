import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * D#483 S5-b2c-3 (R7), acceptance 4: no consumer reads `gh_number` or builds an item branch name itself. The scan works on the syntax tree and, for the two builders, on the
 * type checker, so it is not a search for a variable name:
 *
 *   - a `gh_number` token: an identifier or property of that name, or a string, template or regular expression that holds the word (a SQL text is a string);
 *   - an `fx/issue-` literal: in a string, a template, a regular expression, or a SQL concatenation (`'fx/issue-' || ...` is one string);
 *   - the child shape built by hand: a template of the form `fx/${a}-${b}`;
 *   - a call whose callee RESOLVES (through imports, aliases and re-exports) to `branchFor` or `childBranchFor` declared in work-items/buildIdentity.ts.
 *
 * Comments are not code and are not read. The resolver module is the only exempt file, and it is not a consumer. The shape validators of the runner protocol only match a pattern
 * and build nothing, and are not in the consumer list. The scanner itself is tested on virtual files below, so a new consumer that builds a branch fails.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RESOLVER_SUFFIX = 'work-items/buildIdentity.ts';
const BUILDERS = new Set(['branchFor', 'childBranchFor']);

export interface Finding { file: string; line: number; rule: 'gh_number' | 'fx/issue-' | 'child_template' | 'builder_call'; text: string }

const lineOf = (sf: ts.SourceFile, node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** The literal text a node contributes (string, no-substitution template, template parts, regular expression), or null. */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.text;
  if (ts.isRegularExpressionLiteral(node)) return node.text;
  return null;
}

export function scanSourceFile(sf: ts.SourceFile, checker: ts.TypeChecker, displayName: string): Finding[] {
  const out: Finding[] = [];
  const add = (node: ts.Node, rule: Finding['rule'], text: string) => out.push({ file: displayName, line: lineOf(sf, node), rule, text: text.slice(0, 80) });
  const resolvesToBuilder = (callee: ts.Expression): boolean => {
    let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(callee) ? callee.name : callee);
    if (symbol === undefined) return false;
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return (symbol.declarations ?? []).some((d) => d.getSourceFile().fileName.replace(/\\/g, '/').endsWith(RESOLVER_SUFFIX) && BUILDERS.has(symbol!.name));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'gh_number') add(node, 'gh_number', node.text);
    const text = literalText(node);
    if (text !== null) {
      if (/\bgh_number\b/.test(text)) add(node, 'gh_number', text);
      if (/fx\\?\/issue-/.test(text)) add(node, 'fx/issue-', text);
    }
    // `fx/${a}-${b}`: the head ends in the branch prefix, the one text between the two substitutions is exactly the dash.
    if (ts.isTemplateExpression(node) && node.head.text.endsWith('fx/') && node.templateSpans.length === 2 && node.templateSpans[0]!.literal.text === '-') add(node, 'child_template', node.getText(sf));
    if (ts.isCallExpression(node) && resolvesToBuilder(node.expression)) add(node, 'builder_call', node.expression.getText(sf));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** A program over virtual files (and the real library files for the checker). Paths are absolute and fake; nothing is read from disk but the default library. */
function virtualProgram(files: Record<string, string>): { program: ts.Program; checker: ts.TypeChecker } {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, noEmit: true, skipLibCheck: true, types: [] };
  const host = ts.createCompilerHost(options);
  const known = new Map(Object.entries(files));
  const original = { getSourceFile: host.getSourceFile.bind(host), fileExists: host.fileExists.bind(host), readFile: host.readFile.bind(host) };
  const dirs = new Set<string>();
  for (const f of known.keys()) for (let d = path.posix.dirname(f); d !== '/' && !dirs.has(d); d = path.posix.dirname(d)) dirs.add(d);
  const originalDirectoryExists = host.directoryExists?.bind(host);
  host.directoryExists = (d) => dirs.has(d) || (originalDirectoryExists?.(d) ?? false);
  host.realpath = (f) => f;
  host.fileExists = (f) => known.has(f) || original.fileExists(f);
  host.readFile = (f) => known.get(f) ?? original.readFile(f);
  host.getSourceFile = (f, lang, onError, create) => (known.has(f) ? ts.createSourceFile(f, known.get(f)!, lang) : original.getSourceFile(f, lang, onError, create));
  const program = ts.createProgram([...known.keys()], options, host);
  return { program, checker: program.getTypeChecker() };
}

const V = '/virtual/packages/core/src/work-items/buildIdentity.ts';
const resolverText = 'export const branchFor = (n: number): string => `fx/issue-${n}`;\nexport const childBranchFor = (n: number, k: string): string => `fx/${n}-${k}`;\n';
const scanVirtual = (consumer: string, extra: Record<string, string> = {}): Finding[] => {
  const file = '/virtual/packages/worker/src/checkFix.ts';
  const { program, checker } = virtualProgram({ [V]: resolverText, [file]: consumer, ...extra });
  return scanSourceFile(program.getSourceFile(file)!, checker, 'packages/worker/src/checkFix.ts');
};

describe('the build identity source scan (D#483 S5-b2c-3, R7)', () => {
  describe('the scanner, on fixtures', () => {
    it('a clean consumer and comments that name the forbidden things pass', () => {
      expect(scanVirtual('// reads gh_number and builds `fx/issue-${n}` and calls branchFor(n)\n/* fx/issue-5 */\nexport const x = 1;\nexport const y = "issue-12";\n')).toEqual([]);
    });

    it('a template that builds fx/issue-<n> fails, naming the file and the line', () => {
      expect(scanVirtual('export const n = 3;\nexport const b = `fx/issue-${n}`;\n')).toEqual([{ file: 'packages/worker/src/checkFix.ts', line: 2, rule: 'fx/issue-', text: 'fx/issue-' }]);
    });

    it('a SQL concatenation that builds fx/issue-<n> fails', () => {
      expect(scanVirtual("export const sql = \"SELECT 'fx/issue-' || w.x AS branch FROM t\";\n")).toMatchObject([{ rule: 'fx/issue-', line: 1 }]);
    });

    it('a gh_number read fails, as a property, a column in a SQL string and a field of a row type', () => {
      const found = scanVirtual('type Row = { gh_number: string | null };\nexport const q = "SELECT w.gh_number FROM work_items w";\nexport const r = (row: Row) => row.gh_number;\n');
      expect(found.map((f) => [f.rule, f.line])).toEqual([['gh_number', 1], ['gh_number', 2], ['gh_number', 3]]);
    });

    it('a hand-built child branch fails', () => {
      expect(scanVirtual('export const b = (n: number, k: string) => `fx/${n}-${k}`;\n')).toMatchObject([{ rule: 'child_template', line: 1 }]);
      // a run branch prefix is not the child shape
      expect(scanVirtual('export const b = (r: string, g: number) => `fx/${r}-g${g}`;\n')).toEqual([]);
    });

    it('a call of branchFor or childBranchFor fails whatever the callee is called: the symbol is followed through imports, aliases and re-exports', () => {
      const re = { '/virtual/packages/reexporter/src/advance/build.ts': 'export { branchFor, childBranchFor } from "../../../core/src/work-items/buildIdentity.js";\n' };
      const direct = scanVirtual('import { branchFor } from "../../core/src/work-items/buildIdentity.js";\nexport const b = branchFor(4);\n');
      expect(direct).toMatchObject([{ rule: 'builder_call', line: 2 }]);
      const aliased = scanVirtual('import { childBranchFor as make } from "../../core/src/work-items/buildIdentity.js";\nexport const b = make(4, "a");\n');
      expect(aliased).toMatchObject([{ rule: 'builder_call', line: 2 }]);
      const reexported = scanVirtual('import { branchFor as bf } from "../../reexporter/src/advance/build.js";\nexport const b = bf(4);\n', re);
      expect(reexported).toMatchObject([{ rule: 'builder_call', line: 2 }]);
      const namespaced = scanVirtual('import * as id from "../../core/src/work-items/buildIdentity.js";\nexport const b = id.branchFor(4);\n');
      expect(namespaced).toMatchObject([{ rule: 'builder_call', line: 2 }]);
    });

    it('a function of the same name that is not the resolver\'s is not a builder call', () => {
      expect(scanVirtual('const branchFor = (n: number) => String(n);\nexport const b = branchFor(4);\n')).toEqual([]);
    });
  });

  describe('the tree', () => {
    /** Every file named in the consumer rows of the correction, plus the build and the review reads. S5-b2c-4 adds the paired publish files (planePublish.ts, runnerPlanePush.ts) when it converts them. */
    const CONSUMERS = [
      'packages/core/src/decisions/fixRoundGate.ts',
      'packages/worker/src/fixGateStep.ts',
      'packages/worker/src/fixRoundBase.ts',
      'packages/worker/src/fixRoundHeads.ts',
      'apps/web/lib/advanceReviewSteps.ts',
      'packages/worker/src/checkFix.ts',
      'packages/worker/src/resumeDecision.ts',
      'packages/worker/src/continuation.ts',
      'packages/runner/src/targets/jobIssuer.ts',
      'packages/runner/src/runStatusWriter.ts',
      'apps/web/lib/github/continuationBinding.ts',
      'packages/worker/src/prSlotReconcile.ts',
      'packages/worker/src/branchCleanup.ts',
      'packages/pipeline/src/advance/build.ts',
      'packages/pipeline/src/review/context.ts',
      'packages/pipeline/src/review/githubReads.ts',
      'packages/pipeline/src/review/reviewPrompts.ts',
      // converted to the identity in this row: the worker's advance module and the web driver's item load and workflow
      'packages/worker/src/advance.ts',
      'apps/web/lib/advanceSteps.ts',
      'apps/web/workflows/workItemAdvance.ts',
    ];
    /** The exemptions: only the resolver itself, which is not a consumer. */
    const EXEMPT: ReadonlyArray<{ file: string; why: string }> = [{ file: 'packages/core/src/work-items/buildIdentity.ts', why: 'the resolver: the only definition of the branch builders' }];

    it('every consumer file exists, and none is on the exemption list', () => {
      for (const f of CONSUMERS) expect(existsSync(path.join(ROOT, f)), f).toBe(true);
      for (const e of EXEMPT) expect(CONSUMERS).not.toContain(e.file);
      expect(EXEMPT).toHaveLength(1);
    });

    it('passes on the tree: no consumer reads gh_number, builds fx/issue-<n> or a child branch, or calls a branch builder', () => {
      const base = ts.readConfigFile(path.join(ROOT, 'tsconfig.base.json'), ts.sys.readFile).config.compilerOptions as Record<string, unknown>;
      const parsed = ts.convertCompilerOptionsFromJson({ ...base, module: 'ESNext', moduleResolution: 'Bundler', noEmit: true, skipLibCheck: true, types: ['node'] }, ROOT);
      const files = CONSUMERS.map((f) => path.join(ROOT, f));
      const program = ts.createProgram(files, parsed.options);
      const checker = program.getTypeChecker();
      // A control: the checker really follows build.ts's re-export of the builders to the resolver's declarations, so a call through it would be seen.
      const build = checker.getSymbolAtLocation(program.getSourceFile(path.join(ROOT, 'packages/pipeline/src/advance/build.ts'))!)!;
      const reexported = checker.getExportsOfModule(build).find((e) => e.name === 'branchFor')!;
      expect(checker.getAliasedSymbol(reexported).declarations![0]!.getSourceFile().fileName.replace(/\\/g, '/')).toMatch(/work-items\/buildIdentity\.ts$/);
      const findings: Finding[] = [];
      for (const f of CONSUMERS) {
        const sf = program.getSourceFile(path.join(ROOT, f));
        expect(sf, f).toBeDefined();
        findings.push(...scanSourceFile(sf!, checker, f));
      }
      expect(findings).toEqual([]);
    }, 240_000);

    it('the resolver module holds the only definitions of the builders', () => {
      const text = readFileSync(path.join(ROOT, 'packages/core/src/work-items/buildIdentity.ts'), 'utf8');
      expect(text).toMatch(/export const branchFor =/);
      expect(text).toMatch(/export const childBranchFor =/);
      for (const f of [...CONSUMERS, 'packages/pipeline/src/advance/childBuild.ts']) {
        expect(readFileSync(path.join(ROOT, f), 'utf8'), f).not.toMatch(/(?:const|function)\s+(?:branchFor|childBranchFor)\b/);
      }
    });
  });
});
