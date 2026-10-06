import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RESUME_CAUSES, isResumeCause } from "../src/next-role-request";

const CARDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cards");
const README = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "README.md");

/** Every `cause: "<name>"` or `"<name>"` string this text uses in a resume-cause
 *  position, i.e. quoted right after the literal word `cause`. */
function causeNamesUsed(text: string): string[] {
  const out: string[] = [];
  const re = /cause:\s*"([^"]+)"/g;
  for (const m of text.matchAll(re)) {
    const name = m[1];
    if (name !== undefined) out.push(name);
  }
  return out;
}

describe("ResumeContext cause names (project-manager Phase 2 fix round)", () => {
  it("the exported enum has exactly the three named causes", () => {
    expect([...RESUME_CAUSES].sort()).toEqual(["child_result", "request_refused", "timeout"].sort());
  });

  it("project-manager.md's Phase 2 uses only exported cause names, and uses all three", () => {
    const text = readFileSync(path.join(CARDS_DIR, "project-manager.md"), "utf8");
    const used = causeNamesUsed(text);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) {
      expect(isResumeCause(name), `"${name}" is not in RESUME_CAUSES`).toBe(true);
    }
    expect(new Set(used)).toEqual(new Set(RESUME_CAUSES));
  });

  it("README.md's orchestrator requirement uses only exported cause names, and uses all three", () => {
    const text = readFileSync(README, "utf8");
    const used = causeNamesUsed(text);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) {
      expect(isResumeCause(name), `"${name}" is not in RESUME_CAUSES`).toBe(true);
    }
    expect(new Set(used)).toEqual(new Set(RESUME_CAUSES));
  });

  it("no other card invents its own resume-cause name", () => {
    for (const file of readdirSync(CARDS_DIR).filter((f) => f.endsWith(".md"))) {
      if (file === "project-manager.md") continue;
      const text = readFileSync(path.join(CARDS_DIR, file), "utf8");
      for (const name of causeNamesUsed(text)) {
        expect(isResumeCause(name), `${file} uses "${name}", not an exported ResumeCause`).toBe(true);
      }
    }
  });

  it("the check actually rejects a drifted name (deliberate fixture)", () => {
    const drifted = 'On resume: cause: "kid_result" -> track the result.';
    const used = causeNamesUsed(drifted);
    expect(used).toEqual(["kid_result"]);
    expect(isResumeCause(used[0])).toBe(false);
  });
});
