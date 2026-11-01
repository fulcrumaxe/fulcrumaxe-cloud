// D#7 DP8-f2: every code a decision step can leave as `resume_refused` has a fixed card sentence AND a telemetry allowlist entry. The codes are read from the
// resume performer's source, so a code added there without a sentence (or with no OWN_ERROR_CODES entry) fails here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { RESUME_REFUSED_GENERIC, RESUME_REFUSED_SENTENCES, RESUME_REFUSED_START_LEAD, noticeBanner, resumeRefusedSentence } from "../apps/pipeline/pipeline-insight.js";
import { APPROVE_SENTENCES } from "../apps/pipeline/pipeline-actions.js";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages");
const read = (file) => readFileSync(join(PACKAGES, file), "utf8");
const words = (text) => [...text.matchAll(/"([a-z][a-z0-9_]*)"/g)].map((m) => m[1]);
const ownErrorCodes = () => {
  const text = read("telemetry/src/errorCodes.ts");
  const at = text.indexOf("export const OWN_ERROR_CODES");
  return at === -1 ? [] : words(text.slice(at, text.indexOf("\n]", at)));
};
const SILENT = ["kind_mismatch", "target_not_found", "ask_not_resumable"];
// resumeDecision.ts maps these two identity refusals to work_item_not_resumable before recording.
const MAPPED_AWAY = ["no_issue_link", "not_found"];

// D#7 C31: the producers' exported lists, read as text (the producer files import packages this .mjs cannot load). A code in them that a resumed start can record needs a sentence.
const CORE = join(PACKAGES, "core", "src");
const listAfter = (file, name) => words((new RegExp(`${name}[^=]*= \\[([^\\]]*)\\]`).exec(readFileSync(join(CORE, file), "utf8"))?.[1] ?? "").replaceAll("'", '"'));
const buildBlockers = () => words(/type ChildBuildBlocker = ([^;]*);/.exec(readFileSync(join(CORE, "work-items/buildIdentity.ts"), "utf8"))?.[1] ?? "");

function recordedCodes() {
  // Only the literals inside a note(...) or refuse(...) call's own arguments: a `kind === "halt"` test on the same line is not a code.
  const calls = [...read("worker/src/resumeDecision.ts").matchAll(/\b(?:note|refuse)\(([^)\n]*)\)/g)].map((m) => m[1]);
  const own = calls.flatMap(words);
  const identity = listAfter("work-items/buildIdentity.ts", "BUILD_IDENTITY_REFUSALS");
  return [...new Set([...own, ...identity, ...buildBlockers()])].filter((c) => !SILENT.includes(c) && !MAPPED_AWAY.includes(c)).sort();
}
// Codes that deliberately read as the residual sentence; each is named in the PR's Customer copy block for approval.
// parent_no_envelope: the build's envelope check can record it; no sentence is approved for it (D#7 C31 item 5), so it reads the residual.
const RESIDUAL_ON_PURPOSE = ["parent_no_envelope"];
const banner = (reason) => noticeBanner({ notice: { kind: "resume_refused", reason } });
const OWN = ownErrorCodes();
const FOUND = recordedCodes();

describe("resume refusal codes: a new code needs a card sentence and a telemetry entry", () => {
  it("finds the codes it should, so the scan cannot go quiet", () => {
    expect(OWN.length).toBeGreaterThan(50);
    expect(FOUND).toEqual(
      expect.arrayContaining(["ask_no_run", "work_item_not_resumable", "prompt_not_retained", "principal_not_authorised", "fix_round_context_missing", "spec_unavailable", "execution_mode_changed", "resume_pause_expired", "resume_failed", "no_repo", "start_refused", "child_orphaned", "parent_closed", "respec_needs_approval", "key_not_in_approved_spec", "parent_no_envelope"]),
    );
    expect(listAfter("decisions/childLaunch.ts", "CHILD_LAUNCH_CODES")).toEqual(expect.arrayContaining(buildBlockers()));
  });
  it("every recorded code has a sentence (own, via the start table, or a named residual) and an OWN_ERROR_CODES entry", () => {
    for (const code of FOUND) {
      const named = Object.hasOwn(RESUME_REFUSED_SENTENCES, code) || Object.hasOwn(APPROVE_SENTENCES, code) || RESIDUAL_ON_PURPOSE.includes(code);
      expect(named, `${code} has no card sentence and is not a named residual`).toBe(true);
      expect(OWN, `${code} missing from OWN_ERROR_CODES`).toContain(code);
    }
    for (const code of Object.keys(RESUME_REFUSED_SENTENCES)) expect(OWN, code).toContain(code);
  });
  it("only the codes the source can record have their own sentence (already_answered is the answer path's, C22)", () => {
    expect(Object.keys(RESUME_REFUSED_SENTENCES).filter((c) => !FOUND.includes(c))).toEqual(["already_answered"]);
  });
});

describe("the resume_refused card sentences (D#7 C22 A6, C28)", () => {
  const WORDS = {
    work_item_not_resumable: "Your answer was saved, but this item was stopped or closed, so it didn't continue.",
    already_answered: "Someone already answered this question. Their answer was used.",
    ask_no_run: "This question can't be answered here because its run has ended. Use Build again to start a new run.",
    prompt_not_retained: "Your answer was saved, but the original request isn't kept any more, so the work didn't continue. Use Build again to start a new run.",
    principal_not_authorised: "Your answer was saved, but only an owner or an admin can start this, so it didn't continue.",
    fix_round_context_missing: "Your answer was saved, but the fix round's details weren't kept, so it didn't continue. Use Build again to start a new run.",
    spec_unavailable: "Your answer was saved, but the Spec this work follows couldn't be read, so it didn't continue. Check the Spec, then use Build again.",
    execution_mode_changed: "Your answer was saved, but this repository now builds in a different place, so it didn't continue. Use Build again to start it there.",
    resume_pause_expired: "Your answer came after this item's 14-day pause ended, so it didn't continue. Use Build again to start a new run.",
    resume_failed: "Your answer was saved, but the work couldn't continue just now. Use Build again to try again.",
    start_refused: "Your answer was saved, but the work couldn't be started again from where it stopped, so it didn't continue. Use Build again to start a new run.",
    child_orphaned: "Your answer was saved, but the item this planned PR belonged to was deleted, so it didn't continue.",
    parent_closed: "Your answer was saved, but the item this planned PR belongs to is closed, so it didn't continue. Reopen that item to go on.",
    respec_needs_approval: "Your answer was saved, but the Spec changed and needs approval again, so it didn't continue. Approve the Spec, then use Build again.",
    key_not_in_approved_spec: "Your answer was saved, but this planned PR is no longer in the approved Spec, so it didn't continue.",
  };
  for (const [code, sentence] of Object.entries(WORDS)) {
    it(`${code} reads as its one fixed sentence`, () => {
      expect(banner(code)).toEqual({ kind: "resume_refused", title: "", lead: "", tail: "", reason: sentence });
    });
  }
  it("has exactly these sentences", () => {
    expect(Object.keys(RESUME_REFUSED_SENTENCES).sort()).toEqual(Object.keys(WORDS).sort());
  });
  it("a start's own code with a start sentence reads the lead plus that sentence", () => {
    expect(RESUME_REFUSED_START_LEAD).toBe("Your answer was saved, but it didn't continue: ");
    expect(banner("no_repo").reason).toBe("Your answer was saved, but it didn't continue: This item isn't linked to a repository, so nothing can be started.");
    expect(banner("no_model").reason).toBe(RESUME_REFUSED_START_LEAD + "There is no model key for this work yet. Add one in the model settings, then try again.");
  });
  it("an unknown or hostile code, or a click outcome key, reads as the residual sentence, never as its own text", () => {
    expect(RESUME_REFUSED_GENERIC).toBe("This step was refused. Open the item to see what happened.");
    for (const code of [...RESIDUAL_ON_PURPOSE.filter((c) => !Object.hasOwn(APPROVE_SENTENCES, c)), "from_the_future", "constructor", "__proto__", "<b>x</b>", "started_build", "waiting_for_slot", ""]) {
      expect(banner(code).reason, code).toBe(RESUME_REFUSED_GENERIC);
    }
  });
  it("no sentence shows null, undefined or NaN, for every known and unknown code", () => {
    for (const code of [...FOUND, ...Object.keys(WORDS), "from_the_future"]) expect(resumeRefusedSentence(code), code).not.toMatch(/null|undefined|NaN/);
  });
  it("every listed code has a non-empty sentence, and only the named residuals read the residual", () => {
    for (const code of FOUND) {
      const sentence = resumeRefusedSentence(code);
      expect(typeof sentence, code).toBe("string");
      expect(sentence.trim(), code).not.toBe("");
      expect(sentence, code).not.toMatch(/null|undefined|NaN/);
      expect(sentence === RESUME_REFUSED_GENERIC, code).toBe(RESIDUAL_ON_PURPOSE.includes(code));
    }
  });
  it("a notice with a non-string reason draws nothing", () => {
    expect(noticeBanner({ notice: { kind: "resume_refused", reason: null } })).toBeNull();
  });
});
