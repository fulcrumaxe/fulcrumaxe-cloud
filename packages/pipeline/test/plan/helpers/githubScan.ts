import ts from "typescript";

/**
 * D#2 C20 criterion 8, as ruled by C39 (a): H15 makes no GitHub Discussions
 * call at all. The check parses the code (not lines), so it can tell the
 * store's `createDiscussion` binding from a declaration of the same name.
 *
 *   1. No string or template literal contains `addDiscussionComment`,
 *      `updateDiscussion` or `createDiscussion` (GraphQL mutation text in any form).
 *   2. No GitHub client: no import (static, dynamic, require, re-export) of
 *      `@octokit/*` or another GitHub API client, and no string containing `api.github.com`.
 *   3. `addDiscussionComment` and `updateDiscussion` appear nowhere as identifiers.
 *   4. `createDiscussion` appears only as the named, unaliased import from
 *      `@fx/discussions/server` or `@fx/discussions`, or as a reference to
 *      that binding: no local declaration of the name (function, const,
 *      class, parameter, property, type ...), no aliasing in or out, no
 *      re-export, no member access, no property key.
 */
const MUTATION_NAMES = ["addDiscussionComment", "updateDiscussion", "createDiscussion"];
const STORE_MODULES = new Set(["@fx/discussions", "@fx/discussions/server"]);
const GITHUB_CLIENTS = [/^@octokit\//, /^octokit$/, /^@actions\/github$/, /^@fx\/github(\/|$)/, /^graphql-request$/, /^@octokit$/];

export function githubViolations(source: string, fileName = "scratch.ts"): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  let storeBindings = 0;
  const references: ts.Identifier[] = [];

  const stringHits = (text: string): void => {
    for (const name of MUTATION_NAMES) if (text.includes(name)) out.push(`string mentions ${name}`);
    if (text.includes("api.github.com")) out.push("string mentions api.github.com");
  };
  const checkModule = (spec: string, how: string): void => {
    if (GITHUB_CLIENTS.some((re) => re.test(spec))) out.push(`${how} of GitHub client ${spec}`);
  };

  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) stringHits(n.text);
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) stringHits(n.text);

    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier !== undefined && ts.isStringLiteral(n.moduleSpecifier)) {
      checkModule(n.moduleSpecifier.text, ts.isImportDeclaration(n) ? "import" : "re-export");
    }
    if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
      const a = n.arguments[0];
      if (a !== undefined && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) checkModule(a.text, "dynamic import/require");
    }

    if (ts.isIdentifier(n)) {
      if (n.text === "addDiscussionComment" || n.text === "updateDiscussion") out.push(`identifier ${n.text}`);
      if (n.text === "createDiscussion") classify(n);
    }
    ts.forEachChild(n, visit);
  };

  const DECLARATIONS = [
    ts.isFunctionDeclaration, ts.isFunctionExpression, ts.isClassDeclaration, ts.isClassExpression, ts.isVariableDeclaration, ts.isParameter,
    ts.isBindingElement, ts.isTypeAliasDeclaration, ts.isInterfaceDeclaration, ts.isEnumDeclaration, ts.isModuleDeclaration, ts.isImportEqualsDeclaration,
    ts.isTypeParameterDeclaration, ts.isNamespaceImport, ts.isImportClause, ts.isEnumMember,
  ] as const;
  const PROPERTY_KEYS = [
    ts.isPropertyAssignment, ts.isPropertyDeclaration, ts.isPropertySignature, ts.isMethodDeclaration, ts.isMethodSignature,
    ts.isGetAccessorDeclaration, ts.isSetAccessorDeclaration, ts.isShorthandPropertyAssignment,
  ] as const;

  const classify = (id: ts.Identifier): void => {
    const p = id.parent;
    if (ts.isImportSpecifier(p)) {
      const decl = p.parent.parent.parent; // ImportDeclaration
      const spec = ts.isImportDeclaration(decl) && ts.isStringLiteral(decl.moduleSpecifier) ? decl.moduleSpecifier.text : "";
      if (p.propertyName !== undefined) out.push("createDiscussion aliased on import");
      else if (!STORE_MODULES.has(spec)) out.push(`createDiscussion imported from ${spec}, not the store`);
      else if (p.isTypeOnly) out.push("createDiscussion imported as a type only");
      else storeBindings++;
      return;
    }
    if (ts.isExportSpecifier(p)) return void out.push("createDiscussion exported (re-export or alias)");
    if (ts.isPropertyAccessExpression(p) && p.name === id) return void out.push("member access to createDiscussion");
    if (PROPERTY_KEYS.some((f) => f(p) && (p as ts.NamedDeclaration).name === id)) return void out.push("createDiscussion used as a property name");
    if (DECLARATIONS.some((f) => f(p) && (p as ts.NamedDeclaration).name === id)) return void out.push("createDiscussion declared locally");
    references.push(id);
  };

  visit(sf);
  if (references.length > 0 && storeBindings !== 1) out.push("createDiscussion is used but is not imported (once, unaliased) from @fx/discussions");
  if (storeBindings > 1) out.push("createDiscussion imported more than once");
  return [...new Set(out)];
}
