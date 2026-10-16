/** The run-id tag helper (T6a): the id format, the tag and temporary-repo names, and that ownership is an exact match. */
import { describe, expect, it } from "vitest";
import { isRunId, newRunId, ownedBy, parseTag, parseTmpRepo, tagFor, TagError, tmpRepoName } from "../src/tag.js";

const NOW = Date.parse("2026-10-16T18:48:37.123Z");
const RUN = newRunId(NOW, Uint8Array.from([0xa1, 0xb2, 0xc3]));

describe("run id", () => {
  it("is the UTC time and six hex digits", () => {
    expect(RUN).toBe("20261016t184837z-a1b2c3");
    expect(isRunId(RUN)).toBe(true);
  });
  it("needs three random bytes, and only the first three are used", () => {
    expect(() => newRunId(NOW, Uint8Array.from([1, 2]))).toThrow(TagError);
    expect(newRunId(NOW, Uint8Array.from([0, 0, 1, 9, 9]))).toBe("20261016t184837z-000001");
  });
  it("rejects anything that is not that shape", () => {
    for (const v of ["", "x", "20261016t184837z-a1b2c", "20261016t184837z-A1B2C3", "20261016T184837Z-a1b2c3", "20261016t184837z-a1b2c3-x", "../20261016t184837z-a1b2c3"]) expect(isRunId(v), v).toBe(false);
  });
});

describe("tag", () => {
  it("is e2e-<run id>-<label> and parses back", () => {
    const t = tagFor(RUN, "board-card");
    expect(t).toBe("e2e-20261016t184837z-a1b2c3-board-card");
    expect(parseTag(t)).toEqual({ runId: RUN, label: "board-card" });
  });
  it("refuses a bad run id or label", () => {
    expect(() => tagFor("nope", "x")).toThrow(TagError);
    for (const label of ["", "Upper", "has space", "a--b", "-a", "a-", "x".repeat(41), "a/b"]) expect(() => tagFor(RUN, label), label).toThrow(TagError);
  });
  it("is owned by exactly its run, not by a run whose id it merely starts with", () => {
    const t = tagFor(RUN, "board-card");
    expect(ownedBy(t, RUN)).toBe(true);
    expect(ownedBy(t, "20261016t184837z-a1b2c4")).toBe(false);
    expect(ownedBy(`${t}-extra`, RUN)).toBe(true); // a longer label is still this run's
    expect(ownedBy("e2e-20261016t184837z-a1b2c3x-board", RUN)).toBe(false);
    expect(ownedBy("someone-elses-card", RUN)).toBe(false);
    expect(ownedBy(t, "not a run id")).toBe(false);
  });
});

describe("temporary repo name", () => {
  it("is e2e-tmp-<run id> and only that parses", () => {
    expect(tmpRepoName(RUN)).toBe("e2e-tmp-20261016t184837z-a1b2c3");
    expect(parseTmpRepo(tmpRepoName(RUN))).toBe(RUN);
    for (const n of ["e2e-tmp-", "e2e-tmp-x", `${tmpRepoName(RUN)}-old`, `x${tmpRepoName(RUN)}`, "fixture", tagFor(RUN, "x")]) expect(parseTmpRepo(n), n).toBeNull();
    expect(() => tmpRepoName("nope")).toThrow(TagError);
  });
});
