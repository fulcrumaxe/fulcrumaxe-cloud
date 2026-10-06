/**
 * The one definition of "reads the process environment as a whole, or could". Every guard test and every fixture for it
 * calls `envAccessViolations`, so the rules cannot be retyped somewhere else and drift.
 *
 * This is an allowlist, not a list of spellings. In `src`:
 *  - the identifier `process` may appear only in `src/job/cleanEnv.ts`, and there only as `process.env.NAME` or
 *    `process.env[identifier]`, written with nothing between the tokens (no space, line break, comment or `?.`);
 *  - every other `process` token, in any file, is a violation, whatever surrounds it;
 *  - the `process` module may not be imported or required, `globalThis` and `global` may not appear, and a character
 *    escape inside an identifier is refused, so the name cannot be written another way;
 *  - three cheap bans close the usual back doors: the `Function` constructor, `eval` used without a direct call, and
 *    the path `/proc/`.
 *
 * The scan first splits the text into code (strings blanked, comments replaced by one marker character, so a comment
 * between two tokens still separates them) and text with strings kept.
 */
export const ENV_READER_FILE = "src/job/cleanEnv.ts";

const COMMENT_MARK = "\u0001";

/** Splits source text into `code` (strings and template text blanked) and `plain` (strings kept); comments become one marker in both. */
export function splitSource(text: string): { code: string; plain: string } {
  let code = "";
  let plain = "";
  let depth = 0;
  let inTemplate = false;
  const resumeAt: number[] = [];
  for (let i = 0; i < text.length; ) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inTemplate) {
      if (ch === "\\") {
        plain += text.slice(i, i + 2);
        i += 2;
      } else if (ch === "`") {
        inTemplate = false;
        code += ch;
        plain += ch;
        i++;
      } else if (ch === "$" && next === "{") {
        inTemplate = false;
        resumeAt.push(depth++);
        code += "${";
        plain += "${";
        i += 2;
      } else {
        plain += ch;
        i++;
      }
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      code += COMMENT_MARK;
      plain += COMMENT_MARK;
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      code += COMMENT_MARK;
      plain += COMMENT_MARK;
    } else if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      plain += text.slice(i, j + 1);
      code += `${ch}${ch}`;
      i = j + 1;
    } else if (ch === "`") {
      inTemplate = true;
      code += ch;
      plain += ch;
      i++;
    } else {
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (resumeAt.length > 0 && resumeAt[resumeAt.length - 1] === depth) {
          resumeAt.pop();
          inTemplate = true;
        }
      }
      code += ch;
      plain += ch;
      i++;
    }
  }
  return { code, plain };
}

const PROCESS_TOKEN = /(?<![\p{ID_Continue}$])process(?![\p{ID_Continue}$])/gu;
const NAMED_LOOKUP = /^\.env(?:\.[A-Za-z_$][\w$]*|\[[A-Za-z_$][\w$]*\])/;

/** Every rule the text breaks, by name. Empty means the text reads the environment only by name, and only where that is allowed. */
export function envAccessViolations(text: string, file: string = ENV_READER_FILE): string[] {
  const { code, plain } = splitSource(text);
  const found = new Set<string>();
  for (const match of code.matchAll(PROCESS_TOKEN)) {
    if (file !== ENV_READER_FILE) found.add("process outside the environment reader");
    else if (!NAMED_LOOKUP.test(code.slice(match.index + match[0].length))) found.add("process used other than as process.env.NAME or process.env[name]");
  }
  if (/\\u/.test(code)) found.add("character escape in an identifier");
  if (/["'`](?:node:)?process["'`]/.test(plain)) found.add("import of the process module");
  if (/\b(?:globalThis|global)\b/.test(plain)) found.add("globalThis or global");
  if (/\bFunction\s*\(/.test(code)) found.add("Function constructor");
  if (/\beval\b(?!\s*\()/.test(code)) found.add("eval without a direct call");
  if (/\/proc\//.test(plain)) found.add("/proc/ path");
  return [...found];
}
