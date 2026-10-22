import { describe, expect, it } from "vitest";
import { MAX_VERIFY_ATTEMPTS, VERIFICATIONS } from "@fx/core/src/plan/proposalVerification.js";
import { readFileSync } from "node:fs";
import { exhaustsAttempts, failedRecord, isVerifyEligible, recordFromOutput, rollUp } from "../../src/discovery/verifierResult.js";
import { fileReaderFromContents } from "../../src/discovery/verifierCites.js";
import { fakeGithubContents } from "./fakeGithubContents.js";

const SHA = "c".repeat(40);
const repo = { owner: "acme", name: "widgets" };
const reader = () => fileReaderFromContents(fakeGithubContents(repo, { [SHA]: { "a.ts": "one\ntwo\nthree\n" } }).request, repo);
const claim = (verdict: string, line = 1) => ({ text: `claim ${verdict} ${line}`, verdict, cites: verdict === "unverifiable" ? [] : [{ path: "a.ts", start_line: line, end_line: line }] });

describe("the roll-up (TL ruling 1)", () => {
  const v = (...verdicts: Array<"supported" | "refuted" | "unverifiable">) => verdicts.map((verdict) => ({ verdict }));
  it("all supported is verified; some is partly_verified; none is refuted; unverifiable is not supported", () => {
    expect(rollUp(v("supported", "supported"))).toBe("verified");
    expect(rollUp(v("supported", "refuted"))).toBe("partly_verified");
    expect(rollUp(v("supported", "unverifiable"))).toBe("partly_verified");
    expect(rollUp(v("refuted", "unverifiable"))).toBe("refuted");
    expect(rollUp(v("unverifiable"))).toBe("refuted");
  });
  it("no claims at all is not_checked", () => {
    expect(rollUp([])).toBe("not_checked");
  });
});

describe("recordFromOutput", () => {
  it("covers verified, partly_verified, refuted, and zero claims = not_checked with the attempt counter untouched", async () => {
    const run = (claims: unknown[]) => recordFromOutput({ envelope: { category: "feature", claims }, sha: SHA, reader: reader() });
    expect((await run([claim("supported", 1), claim("supported", 2)])).verification).toBe("verified");
    expect((await run([claim("supported", 1), claim("supported", 9)])).verification).toBe("partly_verified");
    expect((await run([claim("supported", 9)])).verification).toBe("refuted");
    const none = await run([]);
    expect(none).toEqual({ verification: "not_checked", verified_sha: null, claims: [], evidence: [], category: "feature" });
  });

  it("an output refused whole is check_failed and writes nothing else, with a fixed reason", async () => {
    const r = await recordFromOutput({ envelope: { category: "bug", claims: [], class: "internal" }, sha: SHA, reader: reader() });
    expect(r).toEqual({ verification: "check_failed", verified_sha: null, claims: [], evidence: [], category: null, failure: "unknown_field" });
    expect(await recordFromOutput({ envelope: undefined, sha: SHA, reader: reader() })).toEqual(failedRecord("not_an_object"));
  });

  it("a recorded verdict has the definer's argument shape: sha and a claim list the definer accepts", async () => {
    const r = await recordFromOutput({ envelope: { category: "bug", claims: [claim("supported"), claim("supported", 9)] }, sha: SHA, reader: reader() });
    // 0839: verified/partly/refuted need a sha; claims carry only text, verdict and (when refuted) refute_code; evidence only kind, ref, excerpt, commit_sha.
    expect(r.verified_sha).toBe(SHA);
    for (const c of r.claims) expect(Object.keys(c).every((k) => ["text", "verdict", "refute_code"].includes(k))).toBe(true);
    for (const e of r.evidence) expect(Object.keys(e).sort()).toEqual(["commit_sha", "excerpt", "kind", "ref"]);
    expect(r.claims.length).toBeLessThanOrEqual(30);
  });
});

describe("the retry cap", () => {
  it("uses the one constant the read side reports (an import test): the module imports it and defines no cap of its own", () => {
    const src = readFileSync(new URL("../../src/discovery/verifierResult.ts", import.meta.url), "utf8");
    expect(src).toMatch(/import \{ MAX_VERIFY_ATTEMPTS[^}]*\} from "@fx\/core\/src\/plan\/proposalVerification\.js"/);
    expect(src).not.toMatch(/(const|let)\s+\w*(ATTEMPTS|CAP)\w*\s*=/i);
    expect(MAX_VERIFY_ATTEMPTS).toBe(3);
  });

  it("pending is always eligible; check_failed only until the cap; every other verdict never", () => {
    expect(isVerifyEligible({ verification: "pending", verify_attempts: 0 })).toBe(true);
    expect(isVerifyEligible({ verification: "check_failed", verify_attempts: 1 })).toBe(true);
    expect(isVerifyEligible({ verification: "check_failed", verify_attempts: 2 })).toBe(true);
    expect(isVerifyEligible({ verification: "check_failed", verify_attempts: MAX_VERIFY_ATTEMPTS })).toBe(false);
    for (const verification of VERIFICATIONS.filter((x) => x !== "pending" && x !== "check_failed")) {
      expect(isVerifyEligible({ verification, verify_attempts: 0 }), verification).toBe(false);
    }
  });

  it("the third failed check is the last: exhaustsAttempts flips at cap - 1 prior failures", () => {
    expect([0, 1, 2, 3].map((n) => exhaustsAttempts({ verify_attempts: n }))).toEqual([false, false, true, true]);
  });
});
