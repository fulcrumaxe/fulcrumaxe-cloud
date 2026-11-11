import { describe, expect, it } from "vitest";
import { parseAcceptanceScope, parsePrivateFiles, privateOnlyEditsNotAllowed } from "../src/acceptanceScope.js";

/** Paired repositories: a changed path on the private-only list is out of scope unless the Spec lists it in `private_files`. */
describe("privateOnlyEditsNotAllowed", () => {
  const OVERLAY = ["docs/ops/", "plan/*.json"];
  const none = parsePrivateFiles(undefined);

  it("refuses every changed path on the private list, in the order given, and none off it", () => {
    expect(privateOnlyEditsNotAllowed(OVERLAY, none, ["src/a.ts", "docs/ops/x.md", "plan/p.json", "docs/other.md"])).toEqual(["docs/ops/x.md", "plan/p.json"]);
  });

  it("allows exactly what private_files lists", () => {
    const listed = parsePrivateFiles(["docs/ops/x.md"]);
    expect(listed.kind).toBe("known");
    expect(privateOnlyEditsNotAllowed(OVERLAY, listed, ["docs/ops/x.md", "docs/ops/y.md"])).toEqual(["docs/ops/y.md"]);
  });

  it("an unreadable or empty private_files allows nothing", () => {
    for (const bad of [[], "docs/ops/x.md", ["docs/ops/?"], null]) {
      expect(parsePrivateFiles(bad).kind).toBe("unknown");
      expect(privateOnlyEditsNotAllowed(OVERLAY, parsePrivateFiles(bad), ["docs/ops/x.md"])).toEqual(["docs/ops/x.md"]);
    }
  });

  it("matches the way the public push does: case does not hide a private path", () => {
    expect(privateOnlyEditsNotAllowed(OVERLAY, none, ["DOCS/OPS/x.md"])).toEqual(["DOCS/OPS/x.md"]);
  });

  it("an overlay list that does not compile covers nothing here (the push route refuses it on its own)", () => {
    expect(privateOnlyEditsNotAllowed(["docs/[ops]/"], none, ["docs/ops/x.md"])).toEqual([]);
    expect(privateOnlyEditsNotAllowed([], none, ["docs/ops/x.md"])).toEqual([]);
  });

  it("private_files uses the same entry forms as acceptance_files", () => {
    expect(parsePrivateFiles(["docs/ops/**"])).toEqual(parseAcceptanceScope(["docs/ops/**"]));
  });
});
