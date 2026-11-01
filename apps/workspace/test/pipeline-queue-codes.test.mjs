// D#694 B6-5: every error code the Remove from queue / Queue again routes can answer with has a fixed card sentence AND a telemetry allowlist entry.
// The codes are read from the route source (the ApiError literals of the queue routes), so a code added there without both fails here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { APPROVE_SENTENCES, approveSentenceFor } from "../apps/pipeline/pipeline-actions.js";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages");
const read = (rel) => readFileSync(join(PACKAGES, rel), "utf8");
const listed = (file, start) => {
  const text = read(file);
  const at = text.indexOf(start);
  const body = text.slice(at, text.indexOf("\n]", at));
  return at === -1 ? [] : [...body.matchAll(/['"]([a-z][a-z0-9_]*)['"]/g)].map((m) => m[1]);
};
const OWN_ERROR_CODES = listed("telemetry/src/errorCodes.ts", "export const OWN_ERROR_CODES");

/** The text of the two queue routes' helper: from the dequeue seam to the next route helper. */
function queueRouteSource() {
  const text = read("api/src/routes/work-item-actions.ts");
  const from = text.indexOf("async function removeFromQueueRoute");
  return text.slice(from, text.indexOf("\n}\n", from));
}

describe("queue route error codes: a new code needs a card sentence and a telemetry entry", () => {
  const found = [...queueRouteSource().matchAll(/new ApiError\(\d+, "([a-z_]+)"/g)].map((m) => m[1]);

  it("finds the code it should, so the scan itself cannot go quiet", () => {
    expect(OWN_ERROR_CODES.length).toBeGreaterThan(50);
    expect(found).toContain("not_in_queue");
  });

  it("every code has its own card sentence (never the generic one) and is an OWN_ERROR_CODES entry", () => {
    for (const code of new Set(found)) {
      expect(Object.hasOwn(APPROVE_SENTENCES, code), `${code} has no card sentence`).toBe(true);
      expect(approveSentenceFor(code)).not.toBe(approveSentenceFor("something_the_card_does_not_know"));
      expect(OWN_ERROR_CODES, `${code} missing from OWN_ERROR_CODES`).toContain(code);
    }
  });

  it("the sentences name no code and no placeholder", () => {
    expect(approveSentenceFor("not_in_queue")).toBe("That pull request is not in the merge queue. Nothing was changed.");
    expect(approveSentenceFor("not_in_queue")).not.toMatch(/not_in_queue|undefined|null/);
  });
});
