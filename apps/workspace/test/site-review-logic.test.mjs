// D#3 K07b-2: the approve body and the Approve button rule.
import { describe, expect, it } from "vitest";
import { buildApproveBody, canApprove, dayText, pickAcross, pickDefault, refusedSentence, siteLabels, stateText, versionText } from "../apps/site-review/site-review-logic.js";

const review = (over = {}) => ({
  approved: false,
  claims: [{ attested: true }],
  pending_links: ["https://a.example/", "https://b.example/"],
  report: { blockers: [] },
  ...over,
});
const all = new Set(["https://a.example/", "https://b.example/"]);

describe("buildApproveBody", () => {
  it("sends only the ticked links, not the pending list", () => {
    const body = buildApproveBody(["https://a.example/", "https://b.example/"], new Set(["https://b.example/"]));
    expect(body).toEqual({ terms_accepted: true, approved_links: ["https://b.example/"] });
  });
  it("sends none when nothing is ticked or the tick is no longer pending", () => {
    expect(buildApproveBody(["https://a.example/"], new Set(["https://gone.example/"])).approved_links).toEqual([]);
  });
});

describe("canApprove", () => {
  it("is on when everything the user can settle is settled", () => {
    expect(canApprove(review(), all, true)).toBe(true);
  });
  it("is off for terms, an unticked link, an unattested claim, an approved version", () => {
    expect(canApprove(review(), all, false)).toBe(false);
    expect(canApprove(review(), new Set(["https://a.example/"]), true)).toBe(false);
    expect(canApprove(review({ claims: [{ attested: false }] }), all, true)).toBe(false);
    expect(canApprove(review({ approved: true }), all, true)).toBe(false);
  });
  it("is off for a gateSite or leak blocker, but not for stored gates or links blockers", () => {
    const b = (source) => review({ report: { blockers: [{ source }], ok: false } });
    expect(canApprove(b("gateSite"), all, true)).toBe(false);
    expect(canApprove(b("leak"), all, true)).toBe(false);
    expect(canApprove(b("gates"), all, true)).toBe(true);
    expect(canApprove(b("links"), all, true)).toBe(true);
  });
});

describe("refusedSentence", () => {
  const table = { blocked: "The site still has blocking claims." };
  it("returns the sentence for a code the table owns", () => {
    expect(refusedSentence(table, "blocked", "generic")).toBe("The site still has blocking claims.");
  });
  it("gives the fallback for unknown codes and for names on the prototype", () => {
    for (const code of ["nope", "constructor", "__proto__", "toString", "hasOwnProperty", undefined]) {
      expect(refusedSentence(table, code, "generic")).toBe("generic");
    }
  });
});

const ver = (id, created_at, review_state, over = {}) => ({ version_id: id, created_at, review_state, pending_links: 0, pending_claims: 0, ...over });

describe("picker labels", () => {
  it("names a version by date, state and what is left to review", () => {
    expect(versionText(ver("a", "2026-09-18T12:00:00.000Z", "pending", { pending_links: 2, pending_claims: 1 }))).toBe(
      "2026-09-18 12:00 UTC - Awaiting approval - 2 links and 1 claim to review"
    );
    expect(versionText(ver("a", "2026-09-18T12:00:00.000Z", "pending", { pending_links: 1 }))).toBe("2026-09-18 12:00 UTC - Awaiting approval - 1 link to review");
    expect(versionText(ver("a", "2026-09-18T12:00:00.000Z", "approved", { pending_links: 3 }))).toBe("2026-09-18 12:00 UTC - Approved");
  });
  it("never prints null, undefined or NaN for missing or odd fields", () => {
    const text = versionText({ version_id: "a", created_at: "nope", review_state: "mystery", pending_links: null, pending_claims: undefined });
    expect(text).toBe("Unknown date - Unknown state");
    expect(dayText(undefined)).toBe("Unknown date");
    expect(stateText("constructor")).toBe("Unknown state");
  });
  it("names a site by domain and repo, falls back to a short id, and tells twins apart", () => {
    const id = (n) => n.repeat(8) + "-1111-4111-8111-111111111111";
    const labels = siteLabels([
      { id: id("a"), domain: "a.example", repo_full_name: "o/a" },
      { id: id("b"), domain: null, repo_full_name: "o/b" },
      { id: id("c"), domain: null, repo_full_name: null },
      { id: id("d"), domain: "twin.example", repo_full_name: null },
      { id: id("e"), domain: "twin.example", repo_full_name: null },
    ]);
    expect(labels).toEqual(["a.example (o/a)", "o/b", "Site cccccccc", "twin.example - dddddddd", "twin.example - eeeeeeee"]);
  });
});

describe("preselection", () => {
  const rows = [ver("new-approved", "2026-09-20T00:00:00.000Z", "approved"), ver("pending-2", "2026-09-19T00:00:00.000Z", "pending"), ver("pending-1", "2026-09-18T00:00:00.000Z", "pending")];
  it("picks the newest version awaiting approval, else the newest", () => {
    expect(pickDefault(rows).version_id).toBe("pending-2");
    expect(pickDefault([rows[0]]).version_id).toBe("new-approved");
    expect(pickDefault([])).toBeNull();
  });
  it("picks across sites: a pending version beats a newer approved one, and the newer pending wins", () => {
    expect(pickAcross([{ siteId: "s1", rows: [rows[0]] }, { siteId: "s2", rows: [rows[2]] }])).toMatchObject({ siteId: "s2", version: { version_id: "pending-1" } });
    expect(pickAcross([{ siteId: "s1", rows: [rows[2]] }, { siteId: "s2", rows: [rows[1]] }])).toMatchObject({ siteId: "s2" });
    expect(pickAcross([{ siteId: "s1", rows: [rows[0]] }])).toMatchObject({ siteId: "s1", version: { version_id: "new-approved" } });
    expect(pickAcross([{ siteId: "s1", rows: [] }])).toBeNull();
  });
});
