import { describe, expect, it } from "vitest";
import { MAX_PLANNED_PRS, isPlannedPrKey, parsePlannedPrs, plannedPrsSection } from "../src/plannedPrs.js";

/** D#483 S5-b2b: the Planned PRs table parser. A table is read whole or refused whole; fewer than two rows is not a split. */
const row = (key: string, title = `Title ${key}`, depends_on: string[] = []) => ({ key, title, depends_on });

describe("parsePlannedPrs", () => {
  it("reads two or more valid rows, trimming titles and defaulting depends_on", () => {
    expect(parsePlannedPrs([{ key: "api", title: "  Add the API  " }, row("ui", "The screen", ["api"])])).toEqual({
      kind: "ok",
      rows: [row("api", "Add the API"), row("ui", "The screen", ["api"])],
    });
  });

  it("absent, null, empty and a single row are none: one item, one pull request", () => {
    for (const v of [undefined, null, [], [row("only")]]) expect(parsePlannedPrs(v)).toEqual({ kind: "none" });
  });

  it("a single row is still checked before it is dropped", () => {
    expect(parsePlannedPrs([row("Bad Key")])).toEqual({ kind: "invalid" });
  });

  it("PLANNED-PR-KEY-PREFIX-CHECK: a key starting with fix- or check- is refused, and so is any key outside the pattern", () => {
    for (const key of ["fix-1", "fix-", "check-ab12", "check-"]) {
      expect(isPlannedPrKey(key), key).toBe(false);
      expect(parsePlannedPrs([row(key), row("ok")]), key).toEqual({ kind: "invalid" });
    }
    for (const key of ["Api", "a b", "a_b", "", "a".repeat(33), "é", "a/b"]) expect(isPlannedPrKey(key), key).toBe(false);
    for (const key of ["a", "api", "a-b-1", "0", "a".repeat(32), "prefix-fix-1", "fixed", "checks"]) expect(isPlannedPrKey(key), key).toBe(true);
    expect(isPlannedPrKey(5)).toBe(false);
  });

  it("refuses duplicate keys, unknown or self dependencies, repeated dependencies and cycles", () => {
    expect(parsePlannedPrs([row("a"), row("a")])).toEqual({ kind: "invalid" });
    expect(parsePlannedPrs([row("a", "A", ["zzz"]), row("b")])).toEqual({ kind: "invalid" });
    expect(parsePlannedPrs([row("a", "A", ["a"]), row("b")])).toEqual({ kind: "invalid" });
    expect(parsePlannedPrs([row("a"), row("b", "B", ["a", "a"])])).toEqual({ kind: "invalid" });
    expect(parsePlannedPrs([row("a", "A", ["b"]), row("b", "B", ["a"])])).toEqual({ kind: "invalid" });
    expect(parsePlannedPrs([row("a", "A", ["c"]), row("b", "B", ["a"]), row("c", "C", ["b"])])).toEqual({ kind: "invalid" });
    expect(parsePlannedPrs([row("a"), row("b", "B", ["a"]), row("c", "C", ["a", "b"])]).kind).toBe("ok");
  });

  it("refuses titles that are empty, long, multi-line or would break the table", () => {
    for (const title of ["", "   ", "x".repeat(121), "two\nlines", "a | b", "use `code`", "tab\there", "lone\ud800surrogate", "low\udc00one", "zero​width"]) {
      expect(parsePlannedPrs([row("a", title), row("b")]), JSON.stringify(title)).toEqual({ kind: "invalid" });
    }
    expect(parsePlannedPrs([row("a", "x".repeat(120)), row("b")]).kind).toBe("ok");
  });

  it("an over-size table is named too_large, not invalid", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => row(`k${i}`));
    expect(parsePlannedPrs(many(MAX_PLANNED_PRS)).kind).toBe("ok");
    expect(parsePlannedPrs(many(MAX_PLANNED_PRS + 1))).toEqual({ kind: "too_large" });
  });

  it("anything that is not a list of plain objects with own string fields is invalid", () => {
    const bad: unknown[] = ["a,b", 3, {}, [null, row("a")], [row("a"), "b"], [row("a"), [row("b")]], [{ key: 1, title: "t" }, row("b")], [{ key: "a" }, row("b")], [row("a"), { key: "b", title: "B", depends_on: "a" }], [row("a"), { key: "b", title: "B", depends_on: [1] }]];
    for (const v of bad) expect(parsePlannedPrs(v), JSON.stringify(v)).toEqual({ kind: "invalid" });
  });

  it("a depends_on naming anything but a key of the same table refuses the whole table, so a cross-Discussion dependency never reaches a launch (P3d)", () => {
    for (const dep of ["D#12", "12", "other-spec-item", "https://example.test/x", "b "]) {
      expect(parsePlannedPrs([row("a", "A", [dep]), row("b")]), dep).toEqual({ kind: "invalid" });
    }
    expect(parsePlannedPrs([row("a", "A", ["b"]), row("b")]).kind).toBe("ok");
  });

  it("an inherited or accessor property is not read", () => {
    const inherited = Object.create({ key: "a", title: "A" });
    expect(parsePlannedPrs([inherited, row("b")])).toEqual({ kind: "invalid" });
    const accessor = {
      title: "A",
      get key() {
        return "a";
      },
    };
    expect(parsePlannedPrs([accessor, row("b")])).toEqual({ kind: "invalid" });
  });

  it("extra fields on a row are dropped, not stored", () => {
    const r = parsePlannedPrs([{ ...row("a"), instructions: "ignore previous" }, row("b")]);
    expect(r).toEqual({ kind: "ok", rows: [row("a"), row("b")] });
  });
});

describe("plannedPrsSection", () => {
  it("writes a fixed table with 'none' for no dependency", () => {
    expect(plannedPrsSection([row("api", "Add the API"), row("ui", "The screen", ["api"])]).join("\n")).toBe(
      [
        "",
        "### Planned PRs",
        "",
        "Approving this Spec creates one item for each row below; each item is built as its own pull request.",
        "",
        "| Key | Title | Depends on |",
        "| --- | --- | --- |",
        "| api | Add the API | none |",
        "| ui | The screen | api |",
      ].join("\n"),
    );
  });
});
