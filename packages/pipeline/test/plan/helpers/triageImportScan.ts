import { dirname, resolve } from "node:path";
import ts from "typescript";

/**
 * C41 H15c-HARD-3: finds every reference to the `plan/triage` MODULE PATH in
 * a source file, however it is spelled: a static import (default, named,
 * namespace, type-only, side-effect), a re-export (`export ... from`), a
 * dynamic `import()`, a `require()`, an `import x = require()`, and a
 * dynamic import/require whose argument is not a literal but mentions
 * "triage". Scanning the path, not the exported name, is what catches a
 * namespace import used through a computed key (`t["triage" + "Intake"]`),
 * which no name search can see.
 *
 * Files inside `packages/pipeline/src/plan/` are the module's own neighbours
 * and are not asked; the caller passes every other source file.
 */
export function findTriageImports(source: string, filePath: string, planDir: string): string[] {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const triage = resolve(planDir, "triage");
  const found: string[] = [];

  const namesTriage = (spec: string): boolean => {
    if (spec.startsWith(".")) {
      const target = resolve(dirname(filePath), spec).replace(/\.[cm]?[jt]sx?$/, "");
      return target === triage;
    }
    return /(^|\/)plan\/triage(\.[cm]?[jt]sx?)?$/.test(spec);
  };
  const literal = (n: ts.Node | undefined): string | null =>
    n !== undefined && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;

  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier !== undefined) {
      const spec = literal(n.moduleSpecifier);
      if (spec !== null && namesTriage(spec)) found.push(`${ts.isImportDeclaration(n) ? "import" : "re-export"} of "${spec}"`);
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const spec = literal(n.moduleReference.expression);
      if (spec !== null && namesTriage(spec)) found.push(`import-equals of "${spec}"`);
    } else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
      const arg = n.arguments[0];
      const spec = literal(arg);
      if (spec !== null) {
        if (namesTriage(spec)) found.push(`dynamic import/require of "${spec}"`);
      } else if (arg !== undefined && /triage/i.test(arg.getText(sf))) {
        found.push(`computed import/require mentioning triage: ${arg.getText(sf)}`);
      }
    } else if (ts.isImportTypeNode(n)) {
      const spec = ts.isLiteralTypeNode(n.argument) ? literal(n.argument.literal) : null;
      if (spec !== null && namesTriage(spec)) found.push(`import("${spec}") type`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}
