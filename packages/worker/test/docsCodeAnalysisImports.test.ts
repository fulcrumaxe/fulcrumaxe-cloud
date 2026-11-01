import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * D#483 S4-f3, C25-f3-2 (R-597-1): the analysis pass only proposes. It reaches the inbox through one writer (`mergeCandidates`) and imports nothing that
 * starts, approves or advances work: no stage driver, no start gate, no approval, no work-item or action-request module. The import graph is read from the
 * module's own text, so a new import of any of them fails here.
 */
const SRC = readFileSync(new URL("../src/docsCodeAnalysis.ts", import.meta.url), "utf8");
const specifiers = [...SRC.matchAll(/^import\s[^"']*["']([^"']+)["']/gm)].map((m) => m[1]!);

describe("the analysis pass's imports (R-597-1)", () => {
  it("imports the queue, the merge writer and the run starter's types, and nothing of the stage driver, start gate, approval or work items", () => {
    expect(specifiers.length).toBeGreaterThan(5);
    expect(specifiers).toContain("@fx/core/src/discovery/candidates.js");
    for (const s of specifiers) expect(s, s).not.toMatch(/advance|stage|start-?gate|startGate|approve|work-?items?|runActions|receipt|dial|autoStart|pipeline/i);
  });

  it("writes through no table of work: its SQL names none of work_items, run_action_requests, start_gate or approvals", () => {
    for (const table of ["work_items", "run_action_requests", "start_gate", "approvals", "proposal_record_verification", "proposal_decide"]) expect(SRC, table).not.toContain(table);
    // Its only proposal write is the merge writer; it reads proposals for the prompt's list and nothing else.
    expect(SRC.match(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+proposals/gi)).toBeNull();
  });
});
