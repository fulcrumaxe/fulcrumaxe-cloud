// apps/workspace/test/repos-lock.test.mjs
//
// D#6 M1G-a: the Repos app's human-merge-only rules. The DOM wiring is repos-app.js; the vitest environment here is node.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HUMAN_MERGE_LINE, autoMergeDisabled, isLocked, lockNote } from "../apps/repos/repos-lock.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(join(HERE, "..", "apps", "repos", "repos-app.js"), "utf8");
const LOCKED = { auto_merge: false, block_external_auto_merge: true, human_merge_only: true };
const FREE = { auto_merge: false, block_external_auto_merge: true, human_merge_only: false };

describe("the human-merge-only line", () => {
  it("says what the operator set, word for word, for a locked repo", () => {
    expect(HUMAN_MERGE_LINE).toBe("A person merges every pull request in this repository. This is set by the operator.");
    expect(lockNote(LOCKED)).toBe(HUMAN_MERGE_LINE);
  });
  it("is hidden for an unlocked repo, a missing key and any value but the literal true", () => {
    for (const s of [FREE, { auto_merge: false }, { human_merge_only: "true" }, { human_merge_only: 1 }, null, undefined]) {
      expect(lockNote(s)).toBe("");
      expect(isLocked(s)).toBe(false);
    }
  });
});

describe("the auto-merge control", () => {
  it("cannot enable auto-merge on a locked repo", () => {
    expect(autoMergeDisabled(LOCKED, { isAdmin: true, saving: false })).toBe(true);
  });
  it("can still turn it off when it was on before the lock (turning a setting off is always allowed)", () => {
    expect(autoMergeDisabled({ ...LOCKED, auto_merge: true }, { isAdmin: true, saving: false })).toBe(false);
  });
  it("behaves as before for an unlocked repo: enabled for an admin, disabled for a member or while saving", () => {
    expect(autoMergeDisabled(FREE, { isAdmin: true, saving: false })).toBe(false);
    expect(autoMergeDisabled(FREE, { isAdmin: false, saving: false })).toBe(true);
    expect(autoMergeDisabled(FREE, { isAdmin: true, saving: true })).toBe(true);
  });
});

describe("the app uses them", () => {
  it("reads human_merge_only from the settings answer and shows the note with the lock's own helpers", () => {
    expect(APP).toContain("human_merge_only: s.human_merge_only === true");
    expect(APP).toContain("lockNote(st.settings)");
    expect(APP).toContain("autoMergeDisabled(st.settings");
  });
});
