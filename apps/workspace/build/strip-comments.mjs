// apps/workspace/build/strip-comments.mjs
//
// D#37 WS-D4: comment stripper for the shipped (dist) JS and CSS. build.mjs
// runs it on the bytes it writes into dist/ and nowhere else; source files
// keep every comment.
//
// No dependency: a small tokenizer that knows the lexical contexts a comment
// marker can hide in, so a `//` or `/*` inside any of them survives byte for
// byte.
//
//   JS:  '..' and ".." strings (with escapes and line continuations),
//        template literals (including nested `${ ... }` code and nested
//        templates), regex literals (with character classes, where an
//        unescaped `/` does not end the literal), and the `/` division vs
//        regex decision made from the previous token.
//   CSS: '..' and ".." strings, unquoted url(...) bodies, backslash escapes.
//
// Kept on purpose:
//   - `/*!` and `//!` comments, and any comment containing `@license` or
//     `@preserve` (licence text must travel with the code);
//   - comments the toolchain reads as directives: `sourceMappingURL`,
//     `@vite-ignore`, `webpackIgnore`, and `__PURE__` / `__NO_SIDE_EFFECTS__`
//     annotations;
//   - a leading `#!` line;
//   - string-valued directives ("use strict") are not comments and are never
//     touched.
//
// Line handling: a comment that was the only thing on its line takes the line
// with it; trailing whitespace before a removed comment goes too; blank lines
// in code are dropped. A block comment that contained a newline is replaced
// by a newline (it was a line terminator to the parser, so ASI behaves the
// same); a one-line block comment between two tokens becomes one space unless
// a delimiter or whitespace already separates them (so `a/**/+/**/+b` cannot
// turn into `a++b`).
//
// Fail closed: an unterminated string, template, regex or block comment throws
// instead of guessing, so a misread of the source breaks the build loudly
// rather than shipping altered code.

const KEEP_RE = /@license|@preserve|sourceMappingURL|@vite-ignore|webpackIgnore|__PURE__|__NO_SIDE_EFFECTS__/;

// After these words a `/` starts a regex literal, not a division.
const REGEX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
]);

function isIdentChar(c) {
  return (
    (c >= "a" && c <= "z") ||
    (c >= "A" && c <= "Z") ||
    (c >= "0" && c <= "9") ||
    c === "_" ||
    c === "$" ||
    (c > "\x7f" && !isLineTerm(c))
  );
}

// The four ECMAScript line terminators. A `//` comment ends at any of them, a
// regex literal cannot contain one, and ASI looks at them, so the tokenizer
// must treat all four alike. U+2028 and U+2029 are above \x7f, so without this
// they would read as identifier characters.
function isLineTerm(c) {
  return c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029";
}

// Index of the first line terminator at or after `from` (src.length if none).
function lineEnd(src, from) {
  let j = from;
  while (j < src.length && !isLineTerm(src[j])) j++;
  return j;
}

function isWs(c) {
  return c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v";
}

function keepComment(text) {
  return text.startsWith("/*!") || text.startsWith("//!") || KEEP_RE.test(text);
}

// Shared output buffer with the line rules both languages use.
class Out {
  constructor() {
    this.cur = ""; // the current output line
    this.chunks = [];
  }
  // Text copied verbatim (code tokens, literals, kept comments).
  raw(s) {
    this.cur += s;
    const nl = s.lastIndexOf("\n");
    if (nl !== -1) this.cur = s.slice(nl + 1);
    this.chunks.push(s);
  }
  last() {
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i];
      if (c.length > 0) return c[c.length - 1];
    }
    return "";
  }
  // Trim trailing blanks off the current line (code state only).
  trimLine() {
    let removed = 0;
    while (this.chunks.length > 0) {
      const c = this.chunks[this.chunks.length - 1];
      let end = c.length;
      while (end > 0 && isWs(c[end - 1]) && c[end - 1] !== "\n") end--;
      removed += c.length - end;
      if (end === c.length) break;
      if (end === 0) this.chunks.pop();
      else {
        this.chunks[this.chunks.length - 1] = c.slice(0, end);
        break;
      }
    }
    if (removed > 0) this.cur = this.cur.slice(0, Math.max(0, this.cur.length - removed));
  }
  // A newline met in code state: drop blank lines, trim the finished one.
  newline() {
    this.trimLine();
    if (this.cur.length === 0 && this.chunks.length > 0 && this.atLineStart()) return;
    if (this.chunks.length === 0) return;
    this.raw("\n");
  }
  atLineStart() {
    return this.cur.length === 0;
  }
  toString() {
    return this.chunks.join("");
  }
}

export function stripJsComments(src) {
  const out = new Out();
  const n = src.length;
  let i = 0;
  let regexOk = true;
  let afterDot = false;
  // Stack of template contexts: each entry is the brace depth inside a `${`.
  const tpl = [];
  let depth = 0;

  if (src.startsWith("#!")) {
    const end = lineEnd(src, 0);
    out.raw(src.slice(0, end));
    i = end;
  }

  // Scan template text from just after a backtick or a closing `}` of a `${`.
  // Returns true when it stopped at a `${` (code resumes), false at the closing
  // backtick.
  function templateText() {
    const start = i;
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        i++;
        out.raw(src.slice(start, i));
        return false;
      }
      if (c === "$" && src[i + 1] === "{") {
        i += 2;
        out.raw(src.slice(start, i));
        return true;
      }
      i++;
    }
    throw new Error("strip-comments: unterminated template literal");
  }

  function afterValue() {
    regexOk = false;
    afterDot = false;
  }

  while (i < n) {
    const c = src[i];

    if (c === "\n") {
      out.newline();
      i++;
      continue;
    }
    if (c === "\u2028" || c === "\u2029") {
      // A line terminator to the parser (ASI, `return` + newline), but not a
      // newline to the line rules above: emitted as is, after trimming blanks.
      out.trimLine();
      out.raw(c);
      i++;
      continue;
    }
    if (isWs(c)) {
      let j = i;
      while (j < n && isWs(src[j])) j++;
      out.raw(src.slice(i, j));
      i = j;
      continue;
    }

    if (c === "/") {
      const d = src[i + 1];
      if (d === "/") {
        // Ends before the terminator (LF, CR, U+2028 or U+2029), which the main
        // loop then emits itself.
        const j = lineEnd(src, i);
        const text = src.slice(i, j);
        if (keepComment(text)) out.raw(text);
        else out.trimLine();
        i = j;
        continue;
      }
      if (d === "*") {
        const close = src.indexOf("*/", i + 2);
        if (close === -1) throw new Error("strip-comments: unterminated block comment");
        const text = src.slice(i, close + 2);
        i = close + 2;
        if (keepComment(text)) {
          out.raw(text);
        } else if (/[\n\r\u2028\u2029]/.test(text)) {
          // Any line terminator inside the comment was one to the parser.
          out.newline();
        } else {
          const prev = out.last();
          if (isWs(prev)) while (isWs(src[i])) i++; // `a /* c */ b` keeps one space, not two
          const next = src[i] ?? "";
          const bare = prev === "" || isLineTerm(prev) || isWs(prev) || next === "" || isLineTerm(next) || isWs(next);
          const delim = "()[]{},;".includes(prev) || "()[]{},;".includes(next);
          if (!bare && !delim) out.raw(" ");
        }
        continue;
      }
      if (regexOk) {
        // Regex literal.
        let j = i + 1;
        let inClass = false;
        for (;;) {
          if (j >= n || isLineTerm(src[j])) throw new Error("strip-comments: unterminated regex literal");
          const e = src[j];
          if (e === "\\") {
            j += 2;
            continue;
          }
          if (e === "[") inClass = true;
          else if (e === "]") inClass = false;
          else if (e === "/" && !inClass) break;
          j++;
        }
        j++;
        while (j < n && isIdentChar(src[j])) j++;
        out.raw(src.slice(i, j));
        i = j;
        afterValue();
        continue;
      }
      // Division (or /=).
      out.raw(c);
      i++;
      regexOk = true;
      afterDot = false;
      continue;
    }

    if (c === '"' || c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= n || src[j] === "\n" || src[j] === "\r") throw new Error("strip-comments: unterminated string literal");
        const e = src[j];
        if (e === "\\") {
          // Also covers a backslash-newline continuation (CRLF counts as one).
          j += src[j + 1] === "\r" && src[j + 2] === "\n" ? 3 : 2;
          continue;
        }
        if (e === c) break;
        j++;
      }
      out.raw(src.slice(i, j + 1));
      i = j + 1;
      afterValue();
      continue;
    }

    if (c === "`") {
      i++;
      out.raw("`");
      if (templateText()) {
        tpl.push(depth);
        depth = 0;
        regexOk = true;
        afterDot = false;
      } else {
        afterValue();
      }
      continue;
    }

    if (c === "{") {
      depth++;
      out.raw(c);
      i++;
      regexOk = true;
      afterDot = false;
      continue;
    }
    if (c === "}") {
      if (depth === 0 && tpl.length > 0) {
        // Closing a `${`: back to template text.
        out.raw("}");
        i++;
        depth = tpl.pop();
        if (templateText()) {
          tpl.push(depth);
          depth = 0;
          regexOk = true;
        } else {
          afterValue();
        }
        afterDot = false;
        continue;
      }
      if (depth > 0) depth--;
      out.raw(c);
      i++;
      regexOk = true;
      afterDot = false;
      continue;
    }

    if (isIdentChar(c) || c === "\\") {
      let j = i + 1;
      while (j < n && (isIdentChar(src[j]) || src[j] === "\\")) j++;
      // A number like 1.5 or 1e+5: let the decimal point and exponent sign ride along.
      const word = src.slice(i, j);
      out.raw(word);
      i = j;
      const isKeyword = !afterDot && REGEX_KEYWORDS.has(word);
      regexOk = isKeyword;
      afterDot = false;
      continue;
    }

    // Punctuation.
    if (c === "." ) {
      // `.5` starts a number; `...` is spread (regex may follow); `.x` is a member access.
      if (src[i + 1] === "." && src[i + 2] === ".") {
        out.raw("...");
        i += 3;
        regexOk = true;
        afterDot = false;
        continue;
      }
      out.raw(c);
      i++;
      if (src[i] >= "0" && src[i] <= "9") {
        let j = i;
        while (j < n && isIdentChar(src[j])) j++;
        out.raw(src.slice(i, j));
        i = j;
        afterValue();
      } else {
        afterDot = true;
        regexOk = false;
      }
      continue;
    }
    if ((c === "+" || c === "-") && src[i + 1] === c) {
      // ++ / --: postfix keeps "value" state, prefix keeps "operator" state.
      out.raw(c + c);
      i += 2;
      afterDot = false;
      continue;
    }
    if (c === ")" || c === "]") {
      out.raw(c);
      i++;
      afterValue();
      continue;
    }
    out.raw(c);
    i++;
    regexOk = true;
    afterDot = false;
  }

  if (tpl.length > 0) throw new Error("strip-comments: unterminated template substitution");
  return out.toString();
}

// Would deleting a comment between `prev` and `next` (`after` is the char past
// `next`) let the two sides lex as one token, or as a different token? Then the
// comment cannot simply go. Deliberately wide: a false yes costs 4 bytes, a
// false no could change a selector or value.
function cssIdentChar(c) {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_" || c === "-" || c > "\x7f" || c === "\\";
}
function cssFuses(prev, next, after) {
  if (prev === "" || next === "") return false;
  if (cssIdentChar(prev) && cssIdentChar(next)) return true; // div|span, 1px|solid, a-|b
  if (cssIdentChar(prev) && next === "(") return true; // url|(, a function name
  if ("#@.".includes(prev) && cssIdentChar(next)) return true; // hash / at-keyword / class
  if ((prev === "+" || prev === ".") && (/[0-9]/.test(next) || next === ".")) return true; // signed number, .5
  if (/[0-9]/.test(prev) && next === "." && /[0-9]/.test(after)) return true; // 1|.5
  if ("~|^$*".includes(prev) && next === "=") return true; // ~=, |=, ^=, $=, *=
  if (prev === "|" && next === "|") return true;
  if ((prev === "/" && next === "*") || (prev === "*" && next === "/")) return true; // would open or close a comment
  if (prev === "<" && next === "!") return true;
  return false;
}

export function stripCssComments(src) {
  const out = new Out();
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "\n") {
      out.newline();
      i++;
      continue;
    }
    if (isWs(c)) {
      let j = i;
      while (j < n && isWs(src[j])) j++;
      out.raw(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      if (close === -1) throw new Error("strip-comments: unterminated CSS comment");
      const text = src.slice(i, close + 2);
      i = close + 2;
      if (keepComment(text)) {
        out.raw(text);
      } else {
        // A CSS comment is not whitespace: `a/**/.b` is the compound selector
        // `a.b`, not the descendant `a .b`. So nothing is inserted where the
        // comment sat, unless the two sides would fuse into one token; there an
        // empty comment stays, which keeps the tokens apart without turning
        // them into whitespace-separated ones (see cssFuses).
        const prev = out.last();
        if (isWs(prev)) while (isWs(src[i])) i++; // `a /* c */ .b` keeps its one space
        const next = src[i] ?? "";
        if (cssFuses(prev, next, src[i + 1] ?? "")) out.raw("/**/");
      }
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new Error("strip-comments: unterminated CSS string");
        const e = src[j];
        if (e === "\\") {
          j += 2;
          continue;
        }
        if (e === c) break;
        // An unescaped newline ends a CSS string (a parse error); do not guess.
        if (e === "\n") throw new Error("strip-comments: unterminated CSS string");
        j++;
      }
      out.raw(src.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if ((c === "u" || c === "U") && /^url\(/i.test(src.slice(i, i + 4))) {
      let j = i + 4;
      while (j < n && (isWs(src[j]) || src[j] === "\n")) j++;
      if (src[j] === '"' || src[j] === "'") {
        // Quoted url(): emit the head, let the string branch take the rest.
        out.raw(src.slice(i, j));
        i = j;
        continue;
      }
      // Unquoted: raw until the closing paren.
      let k = j;
      while (k < n && src[k] !== ")") {
        if (src[k] === "\\") k++;
        k++;
      }
      if (k >= n) throw new Error("strip-comments: unterminated url()");
      out.raw(src.slice(i, k + 1));
      i = k + 1;
      continue;
    }
    if (c === "\\") {
      out.raw(src.slice(i, i + 2));
      i += 2;
      continue;
    }
    out.raw(c);
    i++;
  }
  return out.toString();
}

// Dispatch on the shipped path. Anything but .js/.mjs/.css is returned as is.
export function stripShippedComments(relPath, content) {
  if (/\.m?js$/.test(relPath)) return stripJsComments(content);
  if (/\.css$/.test(relPath)) return stripCssComments(content);
  return content;
}
