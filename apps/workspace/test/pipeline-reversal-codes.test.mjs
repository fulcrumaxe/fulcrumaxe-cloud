// D#7 DP7-2g: every code the retry adds has a telemetry allowlist entry AND a sentence a person can read. The reason codes are read from the receipts
// package's own source, so a reason added to the worker step without a sentence fails here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { RX_RETRY_REFUSALS, REVERSE_WORDS, reversalRows, rxRetryRefusal } from "../apps/pipeline/pipeline-insight.js";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages");
const read = (file) => readFileSync(join(PACKAGES, file), "utf8");
const words = (text) => [...text.matchAll(/"([a-z][a-z0-9_]*)"/g)].map((m) => m[1]);
const block = (text, start, end) => {
  const at = text.indexOf(start);
  return at === -1 ? "" : text.slice(at, text.indexOf(end, at));
};
const OWN = words(block(read("telemetry/src/errorCodes.ts"), "export const OWN_ERROR_CODES", "\n]"));
const COPY = read("receipts/src/compensate.ts");
const SENTENCES = Object.fromEntries([...block(COPY, "  failed: {", "} satisfies").matchAll(/^\s+([a-z_]+): "([^"]+)"/gm)].map((m) => [m[1], m[2]]));
const REASONS = words(block(COPY, "export const COMPENSATE_REASONS", "] as const"));

describe("D#7 DP7-2g: codes the retry adds have a sentence and a telemetry entry", () => {
  it("finds what it should, so the scan cannot go quiet", () => {
    expect(OWN.length).toBeGreaterThan(50);
    expect(REASONS).toEqual(expect.arrayContaining(["tooling_error", "no_installation", "repo_gone"]));
    expect(Object.keys(SENTENCES).sort()).toEqual([...REASONS].sort());
  });

  it("not_retryable, no_installation and repo_gone are in OWN_ERROR_CODES", () => {
    for (const code of ["not_retryable", "no_installation", "repo_gone"]) expect(OWN, code).toContain(code);
  });

  it("every failed reason has a readable sentence, and the two the worker step added say what to do next", () => {
    for (const reason of REASONS) {
      expect(SENTENCES[reason].trim().length, reason).toBeGreaterThan(20);
      expect(SENTENCES[reason], reason).not.toMatch(/null|undefined|_/);
    }
    expect(SENTENCES.no_installation).toBe("The GitHub App is no longer installed on this repository, so nothing was changed. Install it again, then try again.");
    expect(SENTENCES.repo_gone).toBe("This repository can no longer be reached, so nothing was changed. Once it is connected again, try again.");
  });

  it("a failed row with each reason and a can_retry flag reads as words on the card, with Try again only where the server allowed it", () => {
    for (const reason of REASONS) {
      for (const can_retry of [true, false]) {
        const r = { id: "r1", label: "A decision", class: 2, at: "2026-10-20T09:30:00.000Z", by: "person", chosen: "a", rejected: "b", reverses_receipt_id: null, reverses_text: "", can_reverse: false,
          reversal: { id: "c1", state: "failed", kind: "revert_pr", reason_code: reason, estimate_usd: null, pr_number: null, can_retry, text: SENTENCES[reason] } };
        const item = reversalRows({ receipts: [r], total: 1 }).items[0];
        expect(item.hint.startsWith(REVERSE_WORDS.failed + " "), reason).toBe(true);
        expect(item.hint, reason).not.toMatch(/null|undefined|_/);
        expect(item.action, `${reason} ${can_retry}`).toBe(can_retry ? "retry" : null);
      }
    }
  });

  it("the retry refusals are words, and the not_retryable one is the one the API's code maps to", () => {
    expect(Object.keys(RX_RETRY_REFUSALS).sort()).toEqual(["forbidden", "insufficient_role", "not_retryable"]);
    expect(rxRetryRefusal({ code: "not_retryable" })).toBe(RX_RETRY_REFUSALS.not_retryable);
  });
});
