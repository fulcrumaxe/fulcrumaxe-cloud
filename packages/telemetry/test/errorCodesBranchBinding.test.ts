import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OWN_ERROR_CODES, errorCodeOrOther } from "../src/errorCodes.js";

/** D#599 PL-2b-2: the two refusal codes of the item pull request branch binding are kept, in a block of their own. */
describe("the item branch binding codes", () => {
  it("are kept instead of folded into other, next to each other", () => {
    const codes = ["runner_branch_unbound", "ticket_branch_unbound"];
    for (const code of codes) expect(errorCodeOrOther(code), code).toBe(code);
    const first = OWN_ERROR_CODES.indexOf(codes[0]!);
    expect(OWN_ERROR_CODES.slice(first, first + codes.length)).toEqual(codes);
    const source = readFileSync(path.join(__dirname, "..", "src", "errorCodes.ts"), "utf8");
    expect(source).toContain("// Item pull request branch binding (D#599 PL-2b-2)");
  });
});
