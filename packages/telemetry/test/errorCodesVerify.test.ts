import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OWN_ERROR_CODES, errorCodeOrOther } from "../src/errorCodes.js";

/** D#6 V1: the verify stage's reason codes and refusals are kept instead of folded into other, in a block of their own. */
describe("the verify stage codes", () => {
  const reasons = [
    "no_browser", "chrome_not_connected", "wrong_account", "sign_in_refused", "deploy_failed", "deployment_unreachable", "commit_not_deployed",
    "envelope_rejected", "hollow_pass", "journey_blocked", "journeys_missing", "run_failed", "verify_disabled", "account_unverifiable", "no_visible_journeys",
  ];
  const refusals = ["verify_base_url_invalid", "verify_base_url_required", "verify_setting_invalid", "verify_row_invalid", "verify_bug_item_not_attached"];
  it("keeps every reason and refusal, next to each other", () => {
    const all = [...reasons, ...refusals];
    for (const code of all) expect(errorCodeOrOther(code), code).toBe(code);
    const first = OWN_ERROR_CODES.indexOf(all[0]!);
    expect(OWN_ERROR_CODES.slice(first, first + all.length)).toEqual(all);
    const source = readFileSync(path.join(__dirname, "..", "src", "errorCodes.ts"), "utf8");
    expect(source).toContain("// Verify stage (D#6 V1)");
  });
  it("names the same reasons the table's check accepts (the list 1010 replaced 1003's with)", () => {
    const dir = path.join(__dirname, "..", "..", "db", "migrations");
    const sql = readFileSync(path.join(dir, "1010_verify_visible_criteria.sql"), "utf8");
    const list = /verify_rows_reason_check CHECK \(reason_code IN \(([^)]*)\)\)/.exec(sql)![1]!;
    expect([...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual(reasons);
  });
});
