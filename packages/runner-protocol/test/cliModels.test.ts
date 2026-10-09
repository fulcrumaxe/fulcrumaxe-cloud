import { describe, expect, it } from "vitest";
import { CLI_MODEL_NAMES, cliModelNameFor, modelIdForCliName } from "../src/index.js";

describe("the price-table id to CLI model name table", () => {
  it("pins each name, confirmed against the installed CLI (2.1.295)", () => {
    expect(CLI_MODEL_NAMES).toEqual({ "haiku-4.5": "claude-haiku-4-5", "sonnet-5": "claude-sonnet-5", "opus-5": "claude-opus-5" });
  });

  it("maps each id to its name, and the inverse finds the id again", () => {
    for (const [id, name] of Object.entries(CLI_MODEL_NAMES)) {
      expect(cliModelNameFor(id)).toBe(name);
      expect(modelIdForCliName(name)).toBe(id);
      expect(name).not.toBe(id);
    }
  });

  it("knows no other string: not a CLI name, an alias, or an inherited property", () => {
    for (const bad of ["opus", "claude-opus-5", "opus-4", "", "constructor", "__proto__", "toString", "hasOwnProperty"]) expect(cliModelNameFor(bad), bad).toBeUndefined();
    for (const bad of ["opus-5", "opus", "constructor", ""]) expect(modelIdForCliName(bad), bad).toBeUndefined();
  });
});
