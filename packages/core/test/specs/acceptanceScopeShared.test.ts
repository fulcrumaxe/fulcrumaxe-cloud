import { describe, expect, it } from "vitest";
import * as protocol from "@fulcrumaxe/runner-protocol";
import * as core from "../../src/specs/acceptanceScope.js";

/**
 * D#6 SCOPE-IN-JOB: the matcher moved into the runner protocol package so the local runner tests its changed paths with the very code the cloud holds a pull request to. The core path keeps working
 * and is the same functions, not a copy: a second implementation here would let the runner's early test and the cloud's verdict disagree.
 */
describe("the scope matcher the local runner shares with the cloud", () => {
  it("core's path re-exports the protocol package's own functions and constants", () => {
    expect(core.parseAcceptanceScope).toBe(protocol.parseAcceptanceScope);
    expect(core.pathInScope).toBe(protocol.pathInScope);
    expect(core.pathsOutsideScope).toBe(protocol.pathsOutsideScope);
    expect(core.WORKSPACE_LOCKFILES).toBe(protocol.WORKSPACE_LOCKFILES);
    expect([core.MAX_SCOPE_ENTRIES, core.MAX_ENTRY_PATTERNS, core.MAX_SCOPE_PATTERNS]).toEqual([protocol.MAX_SCOPE_ENTRIES, protocol.MAX_ENTRY_PATTERNS, protocol.MAX_SCOPE_PATTERNS]);
  });

  it("a job's already-expanded list reads back as the same known list, so the runner can run the parser on it again", () => {
    const list = ["packages/web/**", "src/{b,c}.ts", "app/(group)/[id]/page.tsx"];
    const cloud = protocol.parseAcceptanceScope(list);
    expect(cloud.kind).toBe("known");
    const entries = cloud.kind === "known" ? [...cloud.entries] : [];
    expect(entries).toEqual(["packages/web/**", "src/b.ts", "src/c.ts", "app/(group)/[id]/page.tsx"]);
    expect(protocol.parseAcceptanceScope(entries)).toEqual(cloud);
  });
});
