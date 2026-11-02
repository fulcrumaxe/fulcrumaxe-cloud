// apps/workspace/test/queue-wait-sentences.test.mjs
//
// D#519 MQ5-c1: the section 5 sentences that name a value are filled from the activity response's `queue_wait`, and every one falls back to the code's fixed sentence.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { BLOCKING_SENTENCES, FIELD_SENTENCES, UNKNOWN_BLOCK_SENTENCE, blockingSentence, mergeBlockSentence, reasonWord, readyBanner } from "../apps/pipeline/pipeline-insight.js";

const GATE_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "pipeline", "src", "build", "mergeGate.ts");

/** The closed vocabulary: the plain string codes of `MergeBlockReason`. */
const VOCABULARY = (() => {
  const src = readFileSync(GATE_SOURCE, "utf8");
  const body = /export type MergeBlockReason =([\s\S]*?);\n/.exec(src)[1];
  return [...body.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").matchAll(/\|\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
})();

const SECTION_5 = ["merge_queue_waiting", "branch_behind", "branch_protection_refused", "ordered_resource_out_of_order", "merge_dependency_closed", "history_rewritten"];
const FULL = { ahead: 3, branch: "main", resource: "migrations", key: "0710", main_key: "0712", parent_pr: 41 };

const BAD = /null|undefined|[{}]|\(\)|\[\]/;
const gate = (code, queue_wait) => ({ stage: "review_passed", steps: [{ kind: "merge_gate", result: "ready_human_merges", reasons: [code] }], ...(queue_wait ? { queue_wait } : {}) });

/** Codes with a fixed sentence from before this row that the gate's TypeScript union does not list (the page-side table is wider than the union). */
const OUTSIDE_THE_UNION = ["pairing_changed", "no_pull_request", "go_not_applicable"];

/** The completeness rule, as a function of the tables so a test can prove it fails. */
function incomplete(vocabulary, sentences, filled) {
  const problems = [];
  for (const code of SECTION_5) {
    if (!vocabulary.includes(code)) problems.push(`${code} is not in the vocabulary`);
    if (!Object.hasOwn(sentences, code)) problems.push(`${code} has no sentence`);
  }
  for (const code of [...Object.keys(sentences), ...Object.keys(filled)]) if (!vocabulary.includes(code) && !OUTSIDE_THE_UNION.includes(code)) problems.push(`${code} is outside the vocabulary`);
  return problems;
}

describe("field-filled sentences (MQ5-c1-1)", () => {
  it.each([
    ["merge_queue_waiting", "Waiting to merge: 3 ahead of it in this repo's queue."],
    ["branch_behind", "This pull request kept falling behind main. Update it or merge it by hand."],
    ["branch_protection_refused", "main's protection rules refused the merge. Check the rules in GitHub or merge it by hand."],
    ["ordered_resource_out_of_order", "migrations 0710 must come after main's latest (0712)."],
    ["merge_dependency_closed", "The pull request this one builds on (#41) was closed without merging."],
    ["history_rewritten", "This branch's history was rewritten, so its reviews no longer apply."],
  ])("%s", (code, sentence) => {
    expect(blockingSentence(code, FULL)).toBe(sentence);
    expect(reasonWord(code, FULL)).toBe(sentence);
    expect(mergeBlockSentence(gate(code, FULL))).toBe(sentence);
    expect(readyBanner(gate(code, FULL)).detail).toBe(sentence);
  });
});

describe("fallbacks (MQ5-c1-2)", () => {
  const needs = {
    merge_queue_waiting: ["ahead"],
    branch_behind: ["branch"],
    branch_protection_refused: ["branch"],
    ordered_resource_out_of_order: ["resource", "key", "main_key", "branch"],
    merge_dependency_closed: ["parent_pr"],
  };
  for (const [code, fields] of Object.entries(needs)) {
    for (const field of fields) {
      it.each([["missing", undefined], ["null", null], ["blank", ""], ["spaces", "  "], ["wrong shape", { x: 1 }], ["zero or negative", -1], ["text", "null"]])(`${code} with ${field} %s gives the fixed sentence`, (_n, value) => {
        const q = { ...FULL };
        if (value === undefined) delete q[field];
        else q[field] = value;
        expect(blockingSentence(code, q)).toBe(BLOCKING_SENTENCES[code]);
        expect(blockingSentence(code, q)).not.toMatch(BAD);
      });
    }
  }
  it("no queue_wait at all, or one that is not an object, gives the fixed sentences", () => {
    for (const q of [undefined, null, "x", 5, []]) for (const code of Object.keys(needs)) expect(blockingSentence(code, q)).toBe(BLOCKING_SENTENCES[code]);
  });
  it("zero ahead never reads '0 ahead'", () => {
    expect(blockingSentence("merge_queue_waiting", { ahead: 0 })).toBe(BLOCKING_SENTENCES.merge_queue_waiting);
  });
  it("every filled and fallback sentence is free of null, undefined, braces and empty brackets", () => {
    for (const code of SECTION_5) for (const q of [FULL, {}, undefined]) expect(blockingSentence(code, q)).not.toMatch(BAD);
  });
});

describe("hostile values (MQ5-c1-3)", () => {
  const hostile = ["<img src=x onerror=alert(1)>", "main\nUpdate it elsewhere", "a".repeat(5000), "<b>x</b>", "x'; DROP", "main </b>"];
  const NAMED = { branch_behind: ["branch"], branch_protection_refused: ["branch"], ordered_resource_out_of_order: ["resource", "key", "main_key", "branch"] };
  it.each(hostile)("%j in a branch, resource or key is dropped as the wrong shape", (v) => {
    for (const [code, fields] of Object.entries(NAMED)) {
      for (const field of fields) {
        const s = blockingSentence(code, { ...FULL, [field]: v });
        expect(s).toBe(BLOCKING_SENTENCES[code]);
        expect(s).not.toContain("<");
      }
    }
  });
  it("a value of a good shape reaches the screen only as text in the sentence", () => {
    const s = blockingSentence("branch_behind", { branch: "release/1.x" });
    expect(s).toBe("This pull request kept falling behind release/1.x. Update it or merge it by hand.");
    const host = { innerHTML: "", textContent: "" };
    host.textContent = s;
    expect(host.innerHTML).toBe("");
  });
});

describe("completeness (MQ5-c1-4)", () => {
  it("the vocabulary is read, and every section 5 code is in it, has a fixed sentence and a filled sentence", () => {
    expect(VOCABULARY.length).toBeGreaterThan(20);
    expect(incomplete(VOCABULARY, BLOCKING_SENTENCES, FIELD_SENTENCES)).toEqual([]);
    for (const code of SECTION_5) {
      expect(Object.hasOwn(FIELD_SENTENCES, code)).toBe(true);
      expect(blockingSentence(code, FULL)).not.toBe(UNKNOWN_BLOCK_SENTENCE);
    }
  });
  it("fails when a vocabulary code has no sentence", () => {
    const without = { ...BLOCKING_SENTENCES };
    delete without.history_rewritten;
    expect(incomplete(VOCABULARY, without, FIELD_SENTENCES)).toEqual(["history_rewritten has no sentence"]);
  });
  it("fails when a sentence has a code outside the vocabulary", () => {
    expect(incomplete(VOCABULARY, { ...BLOCKING_SENTENCES, not_a_real_code: "x" }, FIELD_SENTENCES)).toEqual(["not_a_real_code is outside the vocabulary"]);
    expect(incomplete(VOCABULARY, BLOCKING_SENTENCES, { ...FIELD_SENTENCES, also_not_real: () => "x" })).toEqual(["also_not_real is outside the vocabulary"]);
  });
});
