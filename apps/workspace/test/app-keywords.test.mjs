// apps/workspace/test/app-keywords.test.mjs
//
// MC-10c (fork edit): FULCApps.register keeps an optional `keywords` list and FULCApps.search matches the title and
// each keyword. Same plain, case-insensitive substring match the command palette uses for command names.

import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(async () => {
  globalThis.window = {};
  vi.resetModules();
  await import("../shell/core/app-registry.js");
});

const reg = (id, title, keywords) => window.FULCApps.register(id, { title, keywords });
const found = (q) => window.FULCApps.search(q).map((a) => a.id);

describe("FULCApps.search", () => {
  it("finds an app by its title, ignoring case", () => {
    reg("runners", "Machines", ["Runners"]);
    expect(found("machines")).toEqual(["runners"]);
    expect(found("MACHINES")).toEqual(["runners"]);
    expect(found("mach")).toEqual(["runners"]);
  });

  it("finds an app by a keyword, ignoring case", () => {
    reg("runners", "Machines", ["Runners"]);
    expect(found("Runners")).toEqual(["runners"]);
    expect(found("runn")).toEqual(["runners"]);
    expect(found("RUNNERS")).toEqual(["runners"]);
  });

  it("matches inside a word exactly as titles do, and never across title and keyword", () => {
    reg("runners", "Machines", ["Runners"]);
    reg("pipeline", "Pipeline");
    expect(found("nners")).toEqual(["runners"]);
    expect(found("ines")).toEqual(["runners"]);
    expect(found("machinesrunners")).toEqual([]);
    expect(found("Machines Runners")).toEqual([]);
    expect(found("pipe")).toEqual(["pipeline"]);
    expect(found("zzz")).toEqual([]);
  });

  it("accepts a missing, empty or malformed keywords list", () => {
    reg("a", "Alpha");
    reg("b", "Beta", []);
    reg("c", "Gamma", "not-an-array");
    reg("d", "Delta", [7, null, "", "  ", "Echo"]);
    expect(window.FULCApps.get("a").keywords).toEqual([]);
    expect(window.FULCApps.get("c").keywords).toEqual([]);
    expect(window.FULCApps.get("d").keywords).toEqual(["Echo"]);
    expect(found("alpha")).toEqual(["a"]);
    expect(found("beta")).toEqual(["b"]);
    expect(found("echo")).toEqual(["d"]);
    expect(found("7")).toEqual([]);
    expect(found("null")).toEqual([]);
  });

  it("matches nothing on an empty or blank query", () => {
    reg("a", "Alpha", ["x"]);
    for (const q of ["", "   ", null, undefined]) expect(found(q)).toEqual([]);
  });

  it("only lists apps the scope allows", () => {
    reg("a", "Alpha", ["Shared"]);
    reg("b", "Beta", ["Shared"]);
    window.FULCApps.restrictTo(["a"]);
    expect(found("shared")).toEqual(["a"]);
  });
});
