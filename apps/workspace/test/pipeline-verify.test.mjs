// apps/workspace/test/pipeline-verify.test.mjs
//
// D#749 V4b: the verify section of the Pipeline item card (pipeline-insight.js, pure half) on the repo's contract fixtures. The DOM half (real clicks, reload,
// the setting turned off, the badge pixels, the three viewports) is in e2e/pipeline-verify.spec.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildInsight, verifySection, VERIFY_BUG_LABEL, VERIFY_DETAIL_SENTENCES, VERIFY_HEADING, VERIFY_HOLD_SENTENCES, VERIFY_METHOD_WORDS, VERIFY_REASON_SENTENCES, VERIFY_REASON_UNKNOWN, VERIFY_STATUS_WORDS } from "../apps/pipeline/pipeline-insight.js";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages");
const fx = (name) => JSON.parse(readFileSync(join(PACKAGES, "api", "fixtures", "v1", "getWorkItemActivity", name), "utf8"));
const BUG = "6b1f6c1e-3f5a-4e0e-9a55-0a7b1c2d3e11";

/** The closed reason list, read from the store that owns it, so a reason added there without a sentence here fails this file. */
function coreList(name) {
  const src = readFileSync(join(PACKAGES, "core", "src", "verify", "rows.ts"), "utf8");
  const m = src.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`));
  if (!m) throw new Error(`no ${name} in rows.ts`);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}
const row = (over) => ({ verify: { status: "unverified", reason: "run_failed", method: "playwright_runner", journeys: null, account: null, bug_item_id: null, pr_number: 57, at: "2026-11-10T12:00:00.000Z", ...over } });

describe("D#749 V4b: verify section words", () => {
  it("has a plain sentence for each of the 15 closed reasons, and no others", () => {
    const codes = coreList("VERIFY_REASON_CODES");
    expect(codes).toHaveLength(15);
    expect(Object.keys(VERIFY_REASON_SENTENCES).sort()).toEqual([...codes].sort());
    for (const code of codes) {
      const s = verifySection(row({ reason: code }));
      expect(s.reason, code).toBe(VERIFY_REASON_SENTENCES[code]);
      expect(s.reason, code).not.toMatch(/_|null|undefined/);
      expect(s.reason.endsWith("."), code).toBe(true);
    }
    expect(new Set(Object.values(VERIFY_REASON_SENTENCES)).size).toBe(15);
  });

  it("names every method with words, and the same methods the store allows", () => {
    expect(Object.keys(VERIFY_METHOD_WORDS).sort()).toEqual(coreList("VERIFY_METHODS").sort());
    for (const [id, label] of Object.entries(VERIFY_METHOD_WORDS)) {
      expect(verifySection(row({ method: id })).method).toEqual({ id, label });
      expect(label).not.toMatch(/_/);
    }
  });

  it("covers every row status", () => {
    expect(Object.keys(VERIFY_STATUS_WORDS).sort()).toEqual(coreList("VERIFY_ROW_STATUSES").sort());
  });
});

describe("D#749: the detail line beside an unverified reason", () => {
  it("has a plain sentence for each closed detail code the store allows, and no others", () => {
    const codes = coreList("VERIFY_DETAIL_CODES");
    expect(Object.keys(VERIFY_DETAIL_SENTENCES).sort()).toEqual([...codes].sort());
    for (const code of codes) {
      const s = verifySection(row({ reason: "run_failed", detail: code }));
      expect(s.detail, code).toBe(VERIFY_DETAIL_SENTENCES[code]);
      expect(s.detail, code).not.toMatch(/_|null|undefined/);
      expect(s.detail.endsWith("."), code).toBe(true);
    }
  });

  it("draws no line for no detail, an unknown code, or a row that is not unverified", () => {
    for (const detail of [null, undefined, "", "push_failed", "__proto__", 3]) expect(verifySection(row({ detail })).detail, String(detail)).toBeNull();
    expect(verifySection(row({ status: "verified", reason: null, detail: "verify_answer_missing" })).detail).toBeNull();
  });

  it("the tool-less run: no browser server names the browser and the sign-in line tells the person what to run", () => {
    expect(verifySection(row({ detail: "verify_browser_unavailable" })).detail).toMatch(/test browser did not start/);
    expect(verifySection(row({ detail: "verify_signin_missing" })).detail).toMatch(/fx-runner verify-login/);
  });
});

describe("D#749 V4b: verify section states", () => {
  it("a verified row says so, with the method and the counts", () => {
    const s = verifySection(fx("200-verify-verified.json"));
    expect(s).toMatchObject({ heading: VERIFY_HEADING, status: "verified", reason: null, counts: "3 of 3 steps passed.", method: { id: "playwright_runner", label: "Playwright on your runner" }, bugItemId: null });
    expect(s.text.startsWith("Verified on the deployed app.")).toBe(true);
    expect(s.account).toBe("Signed in as the account set for checking.");
  });

  it("the account line is drawn only when the stored account check is matched; null, mismatch and unverifiable draw none", () => {
    expect(verifySection(fx("200-verify-verified-no-account-check.json")).account).toBeNull();
    for (const account of [null, undefined, "mismatch", "unverifiable", "yes", true]) expect(verifySection(row({ status: "verified", reason: null, account })).account, String(account)).toBeNull();
    expect(verifySection(row({ status: "verified", reason: null, account: "matched" })).account).toBe("Signed in as the account set for checking.");
  });

  it("says which criteria the browser covered and which were left to the code checks, as numbers only", () => {
    const s = verifySection(fx("200-verify-verified.json"));
    expect(s.criteria).toEqual({ browser: "Checked in the browser: criteria 1, 2, 4.", checks: "Left to the code checks and reviews: criterion 3." });
    expect(verifySection(row({ status: "verified", reason: null, criteria: { browser: [], checks: [2, 3] } })).criteria).toEqual({ browser: null, checks: "Left to the code checks and reviews: criteria 2, 3." });
    for (const criteria of [undefined, null, "x", {}, { browser: [], checks: [] }, { browser: ["1; DROP", -1, 99, 1.5], checks: "no" }]) expect(verifySection(row({ status: "verified", reason: null, criteria })).criteria, JSON.stringify(criteria)).toBeNull();
  });
  it("a no_visible_journeys row reads as not checked in a browser, with no counts", () => {
    const s = verifySection(row({ status: "unverified", reason: "no_visible_journeys", criteria: { browser: [], checks: [1, 2] } }));
    expect(s.reason).toBe(VERIFY_REASON_SENTENCES.no_visible_journeys);
    expect(s.counts).toBeNull();
  });
  it("a failed row says so, counts the failures and offers the bug item", () => {
    const s = verifySection(fx("200-verify-failed.json"));
    expect(s).toMatchObject({ status: "failed", counts: "1 of 3 steps passed, 2 failed.", bugItemId: BUG, method: { id: "chrome_runner" } });
  });

  it("a failed row with no bug item, or an id that is not an id, offers none", () => {
    expect(verifySection(row({ status: "failed", reason: null, journeys: { total: 2, passed: 1, failed: 1, other: 0 }, bug_item_id: null })).bugItemId).toBeNull();
    expect(verifySection(row({ status: "failed", reason: null, bug_item_id: "../../etc/passwd" })).bugItemId).toBeNull();
    expect(verifySection(row({ status: "verified", reason: null, bug_item_id: BUG })).bugItemId).toBeNull();
  });

  it("an unverified row gives the reason sentence and no counts, even if counts were sent", () => {
    const s = verifySection(fx("200-verify-unverified-wrong-account.json"));
    expect(s).toMatchObject({ status: "unverified", reason: VERIFY_REASON_SENTENCES.wrong_account, counts: null, bugItemId: null, account: null });
    expect(verifySection(row({ journeys: { total: 3, passed: 3, failed: 0, other: 0 } })).counts).toBeNull();
  });

  it("a row that has not started reads waiting to start, with no reason, no method, no time and no code", () => {
    for (const status of ["pending", "deploying"]) {
      const s = verifySection(row({ status, reason: "deploy_failed", method: "chrome_runner" }));
      expect(s).toMatchObject({ status: "waiting", text: "Waiting to start.", reason: null, method: null, counts: null, bugItemId: null });
      expect(JSON.stringify(s)).not.toMatch(/deploy_failed|chrome_runner|pending|deploying/);
    }
    expect(verifySection(fx("200-verify-waiting.json")).text).toBe("Waiting to start.");
  });

  it("a waiting row held by one of the three limits says why, in a fixed sentence and with when the wait began; never the code", () => {
    const codes = coreList("VERIFY_HOLD_REASONS");
    expect(codes).toEqual(["unconfigured", "run_over_daily", "daily_cap"]);
    expect(Object.keys(VERIFY_HOLD_SENTENCES).sort()).toEqual([...codes].sort());
    expect(new Set(Object.values(VERIFY_HOLD_SENTENCES)).size).toBe(codes.length);
    for (const status of ["pending", "deploying"]) {
      for (const code of codes) {
        const s = verifySection(row({ status, reason: null, hold: { reason: code, since: "2026-11-10T11:30:00.000Z" } }));
        expect(s.status, code).toBe("waiting");
        expect(s.text).toBe("Waiting to start.");
        expect(s.hold.startsWith(VERIFY_HOLD_SENTENCES[code]), code).toBe(true);
        expect(s.hold).toMatch(/Waiting since .+\.$/);
        expect(s.hold).not.toMatch(/_|null|undefined|Invalid/);
        expect(VERIFY_HOLD_SENTENCES[code]).not.toMatch(/_/);
      }
    }
    const fixture = verifySection(fx("200-verify-waiting-held.json"));
    expect(fixture.hold.startsWith(VERIFY_HOLD_SENTENCES.daily_cap)).toBe(true);
  });

  it("no hold line without a known reason, and none on a row that has started or finished (a stale hold is not shown)", () => {
    expect(verifySection(fx("200-verify-waiting.json")).hold).toBeNull();
    expect(verifySection(row({ status: "pending", reason: null, hold: { reason: "from_the_future", since: "2026-11-10T11:30:00.000Z" } })).hold).toBeNull();
    expect(verifySection(row({ status: "pending", reason: null, hold: "daily_cap" })).hold).toBeNull();
    for (const status of ["running", "verified", "failed", "unverified"]) {
      expect(verifySection(row({ status, hold: { reason: "daily_cap", since: "2026-11-10T11:30:00.000Z" } })).hold, status).toBeNull();
    }
    // A reason with no readable time still gives the sentence, never a blank "since".
    const noTime = verifySection(row({ status: "deploying", reason: null, hold: { reason: "unconfigured", since: "not a date" } }));
    expect(noTime.hold).toBe(VERIFY_HOLD_SENTENCES.unconfigured);
  });

  it("a running row says it is being checked and shows its method", () => {
    expect(verifySection(fx("200-verify-running.json"))).toMatchObject({ status: "running", reason: null, method: { id: "playwright_runner" } });
    expect(verifySection(fx("200-verify-running.json")).text.startsWith("Being checked now.")).toBe(true);
  });

  it("a reason this build does not know gets the general sentence and never its code", () => {
    const s = verifySection(row({ reason: "from_the_future" }));
    expect(s.reason).toBe(VERIFY_REASON_UNKNOWN);
    expect(JSON.stringify(s)).not.toContain("from_the_future");
    expect(verifySection(row({ reason: null })).reason).toBe(VERIFY_REASON_UNKNOWN);
  });

  it("draws nothing for an answer without it or with a malformed one", () => {
    expect(verifySection(fx("200-ok.json"))).toBeNull();
    for (const verify of [undefined, null, "x", 3, [], {}, { status: "bogus" }, { status: 5 }]) expect(verifySection({ verify })).toBeNull();
    expect(verifySection(null)).toBeNull();
    expect(buildInsight(fx("200-ok.json")).verify).toBeNull();
    expect(buildInsight(fx("200-verify-failed.json")).verify.status).toBe("failed");
  });

  it("garbage counts and methods are left out rather than printed", () => {
    const s = verifySection(row({ status: "verified", reason: null, method: "hacked", journeys: { total: -1, passed: "3", failed: null } }));
    expect(s.counts).toBeNull();
    expect(s.method).toBeNull();
    expect(s.text).not.toMatch(/null|undefined|NaN/);
  });

  it("the bug item button label is plain words", () => {
    expect(VERIFY_BUG_LABEL).toBe("Open the bug item");
  });
});
