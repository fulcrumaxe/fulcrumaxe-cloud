import { describe, expect, it } from "vitest";
import { CLOUD_CLOSE_EVENT, SCOPE_REFUSAL_EVENT, SCOPE_REFUSAL_MAX_PATHS, cloudClosePayload, parseCloudClose, parseScopeRefusal, scopeRefusalPayload, scopeRefusalSentence, type CloudClose, type ScopeRefusal } from "../src/work-items/scopeRefusal.js";

/** D#6 CHECKFIX-SUCCESS-AS-FAILED: the refusal record's shape, and the sentence the card shows from it. */
const base: ScopeRefusal = { reason: "scope_violation", prNumber: 12, total: 2, paths: ["tests/a.ts", "tests/b.ts"] };

describe("scopeRefusalPayload and parseScopeRefusal", () => {
  it("round-trips a refusal", () => {
    expect(parseScopeRefusal(scopeRefusalPayload(base))).toEqual(base);
    expect(parseScopeRefusal(scopeRefusalPayload({ reason: "scope_unknown", prNumber: 3, total: 1, paths: ["a.ts"], detail: "renamed" }))).toEqual({ reason: "scope_unknown", prNumber: 3, total: 1, paths: ["a.ts"], detail: "renamed" });
    expect(parseScopeRefusal(scopeRefusalPayload({ ...base, total: null, paths: [] }))).toEqual({ ...base, total: null, paths: [] });
  });

  it("keeps at most the first ten paths and drops a path that is not plain text (control characters, too long, empty)", () => {
    const many = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`);
    const cut = scopeRefusalPayload({ ...base, total: 25, paths: many }) as { paths: string[]; total: number };
    expect(cut.paths).toEqual(many.slice(0, SCOPE_REFUSAL_MAX_PATHS));
    expect(cut.total).toBe(25);
    const dirty = scopeRefusalPayload({ ...base, total: 5, paths: ["ok.ts", "bad\nname.ts", "x".repeat(201), "", "bad\u2028.ts"] }) as { paths: string[] };
    expect(dirty.paths).toEqual(["ok.ts"]);
  });

  it("drops a path with a bidirectional control (U+202A-202E, U+2066-2069), on the way in and on the way out, and keeps the characters next to them", () => {
    const bidi = ["\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069"];
    const paths = ["ok.ts", ...bidi.map((c) => `src/a${c}b.ts`), "src/\u2065x.ts", "src/\u202fx.ts", "src/\u206ax.ts"];
    const cleaned = scopeRefusalPayload({ ...base, total: 20, paths }) as { paths: string[] };
    expect(cleaned.paths).toEqual(["ok.ts", "src/\u2065x.ts", "src/\u202fx.ts", "src/\u206ax.ts"]);
    // A stored record that carries one (written by anything else) is cleaned when it is read back.
    expect(parseScopeRefusal({ reason: "scope_violation", prNumber: 1, total: 2, paths: ["ok.ts", "src/a\u202eb.ts"] })!.paths).toEqual(["ok.ts"]);
  });

  it("keeps the repository of the private pull request and the public copy only when they are well-formed (owner/name, a positive number)", () => {
    const named: ScopeRefusal = { ...base, repo: "acme/widgets", publicPr: { codeRepo: "acme/widgets-public", number: 41 } };
    expect(parseScopeRefusal(scopeRefusalPayload(named))).toEqual(named);
    for (const bad of ["widgets", "a/b/c", "acme/ wid", "", "acme/"]) {
      const out = scopeRefusalPayload({ ...base, repo: bad, publicPr: { codeRepo: bad, number: 41 } }) as Record<string, unknown>;
      expect(out).not.toHaveProperty("repo");
      expect(out).not.toHaveProperty("publicPr");
    }
    for (const number of [0, -1, 1.5, Number.NaN]) expect(scopeRefusalPayload({ ...base, publicPr: { codeRepo: "acme/widgets-public", number } })).not.toHaveProperty("publicPr");
    expect(parseScopeRefusal({ ...scopeRefusalPayload(base), publicPr: { codeRepo: "acme/widgets-public", number: "41" } })).toEqual(base);
    expect(parseScopeRefusal({ ...scopeRefusalPayload(base), repo: 7, publicPr: [] })).toEqual(base);
  });

  it("reads back only what this module wrote: another reason, a bad pull request number, a bad count, or a non-object is null", () => {
    expect(parseScopeRefusal(null)).toBeNull();
    expect(parseScopeRefusal([])).toBeNull();
    expect(parseScopeRefusal({ ...scopeRefusalPayload(base), reason: "no_commit" })).toBeNull();
    expect(parseScopeRefusal({ ...scopeRefusalPayload(base), prNumber: 0 })).toBeNull();
    expect(parseScopeRefusal({ ...scopeRefusalPayload(base), prNumber: "12" })).toBeNull();
    expect(parseScopeRefusal({ ...scopeRefusalPayload(base), total: -1 })).toBeNull();
    expect(parseScopeRefusal({ ...scopeRefusalPayload(base), total: "2" })).toBeNull();
  });
});

describe("scopeRefusalSentence", () => {
  it("names the count and each path, and says the pull request was closed and the branch kept", () => {
    const s = scopeRefusalSentence(base);
    expect(s).toMatch(/^The change touched 2 files: tests\/a\.ts, tests\/b\.ts outside the Spec's file list\./);
    expect(s).toMatch(/pull request was closed and its branch was kept; nothing was merged/);
  });

  it("when the public copy was closed too, tells the person to reopen it on GitHub before building again; without one, the plain tail", () => {
    const withPublic = scopeRefusalSentence({ ...base, publicPr: { codeRepo: "acme/widgets-public", number: 41 } });
    expect(withPublic).toMatch(/The public copy was closed too\. To build again, reopen it on GitHub first, then add the files to the Spec's list or build without them\.$/);
    expect(withPublic).toMatch(/branch was kept; nothing was merged/);
    const without = scopeRefusalSentence(base);
    expect(without).not.toMatch(/public copy/);
    expect(without).toMatch(/Add the files to the Spec's file list, or build again without touching them\.$/);
    expect(scopeRefusalSentence({ reason: "scope_unknown", prNumber: 1, total: 1, paths: ["a.ts"], detail: "renamed", publicPr: { codeRepo: "acme/widgets-public", number: 41 } })).toMatch(/reopen it on GitHub first/);
  });

  it("promises a fresh Build again only when the public record ended; a missing or false flag keeps the reopen-it-first words", () => {
    const pub = { ...base, publicPr: { codeRepo: "acme/widgets-public", number: 41 } };
    const fresh = scopeRefusalSentence(pub, { recordEnded: true });
    expect(fresh).toMatch(/The public copy was closed too and stays closed\. Build again starts fresh and opens a new public pull request; add the files to the Spec's list first or build without them\.$/);
    expect(fresh).not.toMatch(/reopen/);
    for (const opts of [undefined, {}, { recordEnded: false }]) {
      const s = scopeRefusalSentence(pub, opts);
      expect(s).toMatch(/To build again, reopen it on GitHub first/);
      expect(s).not.toMatch(/starts fresh/);
    }
    // No public copy: the flag changes nothing.
    expect(scopeRefusalSentence(base, { recordEnded: true })).toBe(scopeRefusalSentence(base));
  });

  it("is singular for one file and counts the paths it could not list", () => {
    expect(scopeRefusalSentence({ ...base, total: 1, paths: ["tests/a.ts"] })).toMatch(/touched 1 file: tests\/a\.ts outside/);
    const many = Array.from({ length: 14 }, (_, i) => `src/f${i}.ts`);
    expect(scopeRefusalSentence({ ...base, total: 14, paths: many.slice(0, SCOPE_REFUSAL_MAX_PATHS) })).toMatch(/touched 14 files: src\/f0\.ts, .*src\/f9\.ts \(and 4 more\) outside/);
  });

  it("an incomplete listing has no count to give, and says so without inventing one", () => {
    const s = scopeRefusalSentence({ ...base, total: null, paths: [] });
    expect(s).toMatch(/more files than GitHub would list/);
    expect(s).not.toMatch(/\d+ files?/);
  });

  it("a scope_unknown names the rename or the change type the check cannot judge", () => {
    expect(scopeRefusalSentence({ reason: "scope_unknown", prNumber: 1, total: 1, paths: ["src/new.ts"], detail: "renamed" })).toMatch(/renames a file \(src\/new\.ts\), which the Spec's file list check cannot judge/);
    expect(scopeRefusalSentence({ reason: "scope_unknown", prNumber: 1, total: 1, paths: ["src/x.ts"], detail: "unknown_change_type" })).toMatch(/kind of file change the Spec's file list check cannot judge \(src\/x\.ts\)/);
  });
});

// D#6 SCOPE-REFUSAL-FOLLOWUPS: the record of a close the cloud made for a cause other than the scope check.
describe("cloudClosePayload and parseCloudClose", () => {
  const close: CloudClose = { cause: "internal_error", prNumber: 12 };

  it("is its own event, so the card (which reads only the scope event) never takes its words from it", () => {
    expect(CLOUD_CLOSE_EVENT).not.toBe(SCOPE_REFUSAL_EVENT);
    expect(CLOUD_CLOSE_EVENT).toBe("run.cloud_pr_closed");
  });

  it("round-trips, with the private repository and the public copy only when they are well-formed", () => {
    expect(parseCloudClose(cloudClosePayload(close))).toEqual(close);
    const named: CloudClose = { ...close, repo: "acme/widgets", publicPr: { codeRepo: "acme/widgets-public", number: 41 } };
    expect(parseCloudClose(cloudClosePayload(named))).toEqual(named);
    for (const bad of ["widgets", "a/b/c", "acme/ wid", "", "acme/"]) {
      const out = cloudClosePayload({ ...close, repo: bad, publicPr: { codeRepo: bad, number: 41 } });
      expect(out).not.toHaveProperty("repo");
      expect(out).not.toHaveProperty("publicPr");
    }
    for (const number of [0, -1, 1.5, Number.NaN]) expect(cloudClosePayload({ ...close, publicPr: { codeRepo: "acme/widgets-public", number } })).not.toHaveProperty("publicPr");
  });

  it("carries nothing but the cause, the number and the two repository names", () => {
    const out = cloudClosePayload({ ...close, repo: "acme/widgets", paths: ["x.ts"], total: 3 } as never);
    expect(Object.keys(out).sort()).toEqual(["cause", "prNumber", "repo"]);
  });

  it("reads back only what this module wrote: another cause, a scope refusal, a bad number and a non-object are null", () => {
    expect(parseCloudClose({ ...cloudClosePayload(close), cause: "scope_violation" })).toBeNull();
    expect(parseCloudClose(scopeRefusalPayload(base))).toBeNull();
    expect(parseScopeRefusal(cloudClosePayload(close))).toBeNull();
    for (const prNumber of [0, -3, 1.5, "12"]) expect(parseCloudClose({ ...cloudClosePayload(close), prNumber })).toBeNull();
    expect(parseCloudClose(null)).toBeNull();
    expect(parseCloudClose([])).toBeNull();
  });
});
