import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { START_REASONS, SUB_ITEM_REASONS } from "../src/autonomy/index.js";

/** The reason names are fixed vocabulary (D#483 S5-a): docs/packages/decisions.md must list exactly the exported values, one line each. */
const DOC = readFileSync(fileURLToPath(new URL("../../../docs/packages/decisions.md", import.meta.url)), "utf8");

function listed(heading: string): string[] {
  const start = DOC.indexOf(`### ${heading}\n`);
  if (start < 0) return [];
  const rest = DOC.slice(start + heading.length + 5);
  const end = rest.search(/^#{2,3} /m);
  const body = end < 0 ? rest : rest.slice(0, end);
  return [...body.matchAll(/^- `([a-z_]+)` — (\S.*)$/gm)].map((m) => m[1]!);
}

describe("docs list exactly the exported reason values", () => {
  it("start reasons", () => {
    expect([...listed("Start reasons")].sort()).toEqual([...START_REASONS].sort());
  });
  it("sub-item launch reasons", () => {
    expect([...listed("Sub-item launch reasons")].sort()).toEqual([...SUB_ITEM_REASONS].sort());
  });
  it("each name appears once, and the checker is not vacuous", () => {
    expect(new Set(listed("Start reasons")).size).toBe(START_REASONS.length);
    expect(new Set(listed("Sub-item launch reasons")).size).toBe(SUB_ITEM_REASONS.length);
    expect(listed("No such heading")).toEqual([]);
  });
});
