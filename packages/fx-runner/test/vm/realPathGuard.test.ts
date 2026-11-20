import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A test that hands the root side a request naming the real install places (`/etc/fx-vmhelper`, `/opt/fx-vmhelper`, `/var/lib/...`, the unit file)
 * and lets it get past the identity check would run the real removal or install on the machine that runs the test, which as root means a real
 * install is deleted. This guard reads the test sources in this directory and fails on a call it cannot show to be safe:
 *  - `applyUninstall(...)` and `applyRootActions(...)` must be given a request that comes from a known scratch-path builder;
 *  - `rootRemoveCommand(...)`, `rootApplyCommand(...)` and `vmCommand(["root-...` must expect a refusal (`.rejects`) on the same statement,
 *    or carry a `// real-paths-safe: <reason>` comment on the line above or the same line.
 * A new builder or a new way to reach the root side is a deliberate edit to this file, with a reason a reviewer can read.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH_REQUEST = /^(L2?\.request\(\)|early|req|changed|first|scratchRequest\(.*\)|marked\(.*\)|withNewConfig\(.*\)|\{ \.\.\.scratchRequest\(.*)$/s;

/** The text of the first argument of the call that starts at `open` (the index just after its opening parenthesis). */
function firstArgument(text: string, open: number): string {
  let depth = 0;
  let quote: string | undefined;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== undefined) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return text.slice(open, i).trim();
      depth--;
    } else if (c === "," && depth === 0) return text.slice(open, i).trim();
  }
  return text.slice(open).trim();
}

/** The statement around an index: from the previous line break that ends a statement to the next semicolon. */
function statementAt(text: string, index: number): { before: string; whole: string } {
  const start = text.lastIndexOf(";\n", index) + 1;
  const end = text.indexOf(";\n", index);
  const whole = text.slice(start, end < 0 ? text.length : end);
  return { before: text.slice(Math.max(0, start - 1), index), whole };
}

const files = readdirSync(HERE).filter((f) => f.endsWith(".test.ts") && f !== "realPathGuard.test.ts");

describe("no test reaches the root side's real places", () => {
  it("scans the test sources in this directory", () => {
    expect(files).toContain("uninstall.test.ts");
    expect(files).toContain("install.test.ts");
  });

  it.each(files)("%s: every apply call is given a scratch request, and every command call expects a refusal or says why it is safe", (file) => {
    const text = readFileSync(path.join(HERE, file), "utf8");
    const bad: string[] = [];
    for (const m of text.matchAll(/\b(applyUninstall|applyRootActions)\(/g)) {
      if (text.slice(Math.max(0, m.index - 20), m.index).includes("function ")) continue;
      const arg = firstArgument(text, m.index + m[0].length);
      if (!SCRATCH_REQUEST.test(arg)) bad.push(`${m[1]}(${arg.slice(0, 60)}...)`);
    }
    for (const m of text.matchAll(/\b(rootRemoveCommand|rootApplyCommand)\(|\bvmCommand\(\["root-/g)) {
      const { whole } = statementAt(text, m.index);
      const lineStart = text.lastIndexOf("\n", m.index) + 1;
      const above = text.slice(text.lastIndexOf("\n", lineStart - 2) + 1, lineStart);
      const sameLine = text.slice(lineStart, text.indexOf("\n", m.index));
      const safe = /\.rejects\b/.test(whole) || /real-paths-safe:/.test(above) || /real-paths-safe:/.test(sameLine);
      if (!safe) bad.push(`${m[0]} at line ${text.slice(0, m.index).split("\n").length}`);
    }
    // the definitions themselves are not calls
    expect(bad.filter((b) => !/function /.test(b)), file).toEqual([]);
  });

  it("would catch a real-places request given to apply, or a command call with no refusal expected", () => {
    const seen = (src: string): string[] => {
      const out: string[] = [];
      for (const m of src.matchAll(/\b(applyUninstall)\(/g)) if (!SCRATCH_REQUEST.test(firstArgument(src, m.index + m[0].length))) out.push("apply");
      for (const m of src.matchAll(/\b(rootRemoveCommand)\(/g)) {
        const { whole } = statementAt(src, m.index);
        if (!/\.rejects\b/.test(whole)) out.push("command");
      }
      return out;
    };
    expect(seen("await applyUninstall(realRequest, ops);\n")).toEqual(["apply"]);
    expect(seen("await applyUninstall(L.request(), ops);\n")).toEqual([]);
    expect(seen("await rootRemoveCommand(host, out);\n")).toEqual(["command"]);
    expect(seen("await expect(rootRemoveCommand(host, out)).rejects.toThrow(/x/);\n")).toEqual([]);
  });
});
