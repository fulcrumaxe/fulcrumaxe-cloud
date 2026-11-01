import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Formatting guard: the worker facade (`buildWorker`'s final `return { ... }`)
// and the destructure in `createWorker` list one top-level property per line,
// so two PRs adding different properties do not conflict on a single line.
// Anchors: the `return {` right after `const runSandboxInventory`, and the
// `({` right after `buildWorker(options).then(`.

const SOURCE = readFileSync(new URL("../src/compositionRoot.ts", import.meta.url), "utf8").split("\n");

/** Depth-0 commas on one line, ignoring brackets and quoted text; a trailing comma does not count. */
function extraTopLevelCommas(line: string): number {
  const text = line.trimEnd().replace(/,$/, "");
  let depth = 0;
  let quote: string | null = null;
  let commas = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === "`") quote = c;
    else if ("({[".includes(c)) depth++;
    else if (")}]".includes(c)) depth--;
    else if (c === "," && depth === 0) commas++;
  }
  return commas;
}

function block(anchor: RegExp, open: string, close: string): string[] {
  const at = SOURCE.findIndex((l) => anchor.test(l));
  expect(at, `anchor ${anchor} not found`).toBeGreaterThanOrEqual(0);
  const start = SOURCE.findIndex((l, i) => i > at && l === open);
  expect(start, `block opener "${open}" after anchor not found`).toBeGreaterThan(at);
  const end = SOURCE.findIndex((l, i) => i > start && l === close);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start + 1, end);
}

describe("compositionRoot facade formatting", () => {
  it.each([
    ["buildWorker return", /const runSandboxInventory = /, "    return {", "    };"],
    ["createWorker destructure", /buildWorker\(options\)\.then\(/, "    ({", "    }) => {"],
  ] as const)("%s keeps one top-level property per line", (_name, anchor, open, close) => {
    const lines = block(anchor, open, close);
    expect(lines.length).toBeGreaterThan(20);
    const crowded = lines.filter((l) => extraTopLevelCommas(l) > 0).map((l) => l.trim().slice(0, 60));
    expect(crowded).toEqual([]);
  });
});
