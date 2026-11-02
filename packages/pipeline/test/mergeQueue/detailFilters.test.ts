import { describe, expect, it } from "vitest";
import { isDetailPath, isDetailRef } from "../../src/mergeQueue/conflict.js";
import { BAD_PATHS, BAD_REFS, GOOD_PATHS, GOOD_REFS } from "./helpers/detailCorpus.js";

/** D#519 MQ4-d-0: the code side of the shared corpus (the SQL side is detailChecks.pg.test.ts). */
describe("conflict-stop detail filters", () => {
  it.each(GOOD_PATHS.map((p) => [p.length > 40 ? `${p.slice(0, 8)}... (${p.length} chars)` : JSON.stringify(p), p]))("a path the table takes: %s", (_n, p) => {
    expect(isDetailPath(p)).toBe(true);
  });
  it.each(BAD_PATHS.map((p) => [p.length > 40 ? `${p.slice(0, 8)}... (${p.length} chars)` : JSON.stringify(p), p]))("a path the table refuses: %s", (_n, p) => {
    expect(isDetailPath(p)).toBe(false);
  });
  it.each(GOOD_REFS.map((r) => [r.length > 40 ? `${r.slice(0, 8)}... (${r.length} chars)` : JSON.stringify(r), r]))("a branch the table takes: %s", (_n, r) => {
    expect(isDetailRef(r)).toBe(true);
  });
  it.each(BAD_REFS.map((r) => [r.length > 40 ? `${r.slice(0, 8)}... (${r.length} chars)` : JSON.stringify(r), r]))("a branch the table refuses: %s", (_n, r) => {
    expect(isDetailRef(r)).toBe(false);
  });
  it("a value that is not a string, or has a lone surrogate, is refused", () => {
    for (const v of [null, undefined, 3, {}, ["a"]]) expect(isDetailPath(v) || isDetailRef(v)).toBe(false);
    expect(isDetailPath("a\ud800b")).toBe(false);
    expect(isDetailRef("a\udc00b")).toBe(false);
  });
});
