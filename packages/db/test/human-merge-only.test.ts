import { describe, expect, it } from "vitest";
import { HUMAN_MERGE_ONLY_ENV, humanMergeOnly, humanMergeOnlyConfigInvalid, parseHumanMergeOnlyIds } from "../src/humanMergeOnly.js";

/** D#6 M1G-a: the parser and the one function that answers "does a person merge this repository". */
const env = (v: string | undefined) => (v === undefined ? {} : { [HUMAN_MERGE_ONLY_ENV]: v });

describe("parseHumanMergeOnlyIds", () => {
  it("accepts an unset value, an empty string and a list of ids", () => {
    expect(parseHumanMergeOnlyIds(undefined)).toEqual({ kind: "ok", ids: new Set() });
    expect(parseHumanMergeOnlyIds("")).toEqual({ kind: "ok", ids: new Set() });
    expect(parseHumanMergeOnlyIds("123")).toEqual({ kind: "ok", ids: new Set([123]) });
    expect(parseHumanMergeOnlyIds("123,456")).toEqual({ kind: "ok", ids: new Set([123, 456]) });
  });

  it("is invalid (closed) for letters, an empty entry, a space, a sign, zero, a leading zero and an unsafe integer", () => {
    for (const bad of ["abc", "1,,2", " 1", "1 ", "-1", "+1", "1,", ",1", "0", "01", "1, 2", "1.5", "9007199254740993", "1;2", " "]) {
      expect(parseHumanMergeOnlyIds(bad), JSON.stringify(bad)).toEqual({ kind: "invalid" });
    }
  });
});

describe("humanMergeOnly", () => {
  it("nothing is locked when the setting is unset or empty", () => {
    for (const id of [1, "1", 1n, null, undefined]) {
      expect(humanMergeOnly(id, env(undefined))).toBe(false);
      expect(humanMergeOnly(id, env(""))).toBe(false);
    }
  });

  it("locks exactly the listed ids, whether the repo id arrives as a number, a string or a bigint", () => {
    const e = env("123,456");
    expect(humanMergeOnly(123, e)).toBe(true);
    expect(humanMergeOnly("456", e)).toBe(true);
    expect(humanMergeOnly(456n, e)).toBe(true);
    expect(humanMergeOnly(124, e)).toBe(false);
    expect(humanMergeOnly("12", e)).toBe(false);
  });

  it("an id that cannot be read counts as locked while any id is listed (it cannot be shown to be unlisted)", () => {
    for (const id of [null, undefined, "abc", "", 0, -5, 1.5, Number.NaN]) expect(humanMergeOnly(id, env("123")), String(id)).toBe(true);
  });

  it("a malformed value locks every repo, and is reported as invalid", () => {
    for (const bad of ["abc", "1,,2", " 1", "-1"]) {
      expect(humanMergeOnly(999, env(bad)), bad).toBe(true);
      expect(humanMergeOnly(null, env(bad)), bad).toBe(true);
      expect(humanMergeOnlyConfigInvalid(env(bad)), bad).toBe(true);
    }
    expect(humanMergeOnlyConfigInvalid(env("1,2"))).toBe(false);
    expect(humanMergeOnlyConfigInvalid(env(undefined))).toBe(false);
    expect(humanMergeOnlyConfigInvalid(env(""))).toBe(false);
  });

  it("reads the environment on every call, with no cache", () => {
    const e: Record<string, string | undefined> = { [HUMAN_MERGE_ONLY_ENV]: "5" };
    expect(humanMergeOnly(5, e)).toBe(true);
    e[HUMAN_MERGE_ONLY_ENV] = "6";
    expect(humanMergeOnly(5, e)).toBe(false);
  });
});
