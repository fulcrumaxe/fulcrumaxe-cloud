// D#7 DP7-2h: a revert pull request that was closed without merging reads as such on the card; every other pr_state keeps the `done` sentence.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { REVERSE_WORDS, reversalRows } from "../apps/pipeline/pipeline-insight.js";

const COPY = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "receipts", "src", "compensate.ts"), "utf8");
const SENTENCE = "The revert pull request was closed without being merged, so the change is still in place.";
const OPENED = "We opened a revert for you to review. Nothing changes until you merge it.";

const row = (prState, text, state = "done") => ({
  id: "r1", label: "A decision", class: 2, at: "2026-10-20T09:30:00.000Z", by: "person", chosen: "a", rejected: "b", reverses_receipt_id: null, reverses_text: "", can_reverse: false,
  reversal: { id: "c1", state, kind: "revert_pr", reason_code: null, estimate_usd: null, pr_number: 7, pr_state: prState, can_retry: false, text },
});
const first = (r) => reversalRows({ receipts: [r], total: 1 }).items[0];

describe("D#7 DP7-2h: revert closed without merging", () => {
  it("the server's sentence is the approved one, word for word", () => {
    expect(COPY).toContain('revert_pr_closed_unmerged: "' + SENTENCE + '"');
  });

  it("closed_unmerged keeps the row done, shows the sentence alone, and does not strike it through", () => {
    expect(first(row("closed_unmerged", SENTENCE))).toMatchObject({ state: "done", struck: false, hint: SENTENCE, action: null });
  });

  it("open, merged, unknown, a missing or a foreign pr_state keep the done sentence and the strike", () => {
    for (const st of ["open", "merged", "unknown", null, undefined, "other"]) {
      expect(first(row(st, OPENED)), String(st)).toMatchObject({ state: "done", struck: true, hint: REVERSE_WORDS.reversed + " " + OPENED });
    }
  });

  it("closed_unmerged on a row that is not done changes nothing", () => {
    const it = first(row("closed_unmerged", "x", "failed"));
    expect(it.hint.startsWith(REVERSE_WORDS.failed)).toBe(true);
    expect(it.hint).not.toContain("closed without");
  });
});
