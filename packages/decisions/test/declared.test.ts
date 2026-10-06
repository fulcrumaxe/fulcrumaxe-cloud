import { describe, expect, it } from "vitest";
import { CATALOGUE_IDS } from "../src/catalogue.js";
import {
  UndeclaredCatalogueEntryError,
  assertDeclarationsResolve,
  findUnresolvedDeclarations,
  resolveDeclaredEntry,
  type DeclaredEntry,
} from "../src/declared.js";

describe("D#7 DP5 criteria 1-2: the declared-classes resolution mechanism", () => {
  it("resolves a declaration naming a real catalogue id to exactly that entry", () => {
    for (const id of CATALOGUE_IDS) {
      const declaration: DeclaredEntry = { source: "test-fixture", decisionType: id };
      expect(resolveDeclaredEntry(declaration)?.id).toBe(id);
    }
  });

  it("findUnresolvedDeclarations returns [] when every declaration resolves (the real catalogue)", () => {
    const declarations: DeclaredEntry[] = CATALOGUE_IDS.map((id) => ({
      source: "real-catalogue-sweep",
      decisionType: id,
    }));
    expect(findUnresolvedDeclarations(declarations)).toEqual([]);
  });

  it("assertDeclarationsResolve does not throw for a fully-resolving set (real tree)", () => {
    const declarations: DeclaredEntry[] = CATALOGUE_IDS.map((id) => ({
      source: "real-catalogue-sweep",
      decisionType: id,
    }));
    expect(() => assertDeclarationsResolve(declarations)).not.toThrow();
  });

  it("catalogue ids are unique, so a resolved declaration resolves to exactly one entry, never more", () => {
    expect(new Set(CATALOGUE_IDS).size).toBe(CATALOGUE_IDS.length);
  });

  it("deliberate-failure fixture: an undeclared class does not resolve (mutation goes red)", () => {
    const bad: DeclaredEntry = { source: "fixture-tool", decisionType: "totally_undeclared_decision_type" };
    expect(resolveDeclaredEntry(bad)).toBeUndefined();
    expect(findUnresolvedDeclarations([bad])).toEqual([bad]);
  });

  it("deliberate-failure fixture, mixed set: one bad declaration among good ones is still caught", () => {
    const good: DeclaredEntry = { source: "good", decisionType: CATALOGUE_IDS.at(0) ?? "" };
    const bad: DeclaredEntry = { source: "bad", decisionType: "totally_undeclared_decision_type" };
    expect(findUnresolvedDeclarations([good, bad])).toEqual([bad]);
  });

  it("criterion 2: a declaration naming no catalogue entry is a build-time failure (throws), not a runtime default", () => {
    const bad: DeclaredEntry = { source: "fixture-tool", decisionType: "totally_undeclared_decision_type" };
    expect(() => assertDeclarationsResolve([bad])).toThrow(UndeclaredCatalogueEntryError);
  });

  it("the thrown error names the offending source and decision type, not a generic message", () => {
    const bad: DeclaredEntry = { source: "tools.ts:fixture_tool", decisionType: "made_up_type" };
    try {
      assertDeclarationsResolve([bad]);
      throw new Error("expected assertDeclarationsResolve to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UndeclaredCatalogueEntryError);
      expect((err as Error).message).toContain("tools.ts:fixture_tool");
      expect((err as Error).message).toContain("made_up_type");
    }
  });
});
