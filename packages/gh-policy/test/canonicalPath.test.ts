import { describe, expect, it } from "vitest";
import { isCanonicalPath } from "../src/canonicalPath.js";

describe("isCanonicalPath", () => {
  it.each([
    "/repos/acme/widgets",
    "/repos/acme/widgets/pulls/1/merge",
    "/repos/acme/widgets/issues/5/labels",
    "/acme/widgets.git/git-upload-pack",
  ])("accepts %s", (path) => {
    expect(isCanonicalPath(path)).toBe(true);
  });

  it("rejects the bare root path '/' (an empty first segment — harmless since nothing matches it anyway)", () => {
    expect(isCanonicalPath("/")).toBe(false);
  });

  it.each([
    ["missing leading slash", "repos/acme/widgets"],
    ["dot segment", "/repos/acme/widgets/pulls/1/./merge"],
    ["dot-dot segment", "/repos/acme/widgets/pulls/../pulls/1/merge"],
    ["dot-dot segment deep escape", "/repos/acme/widgets/pulls/../../../evil/x/pulls"],
    ["empty segment (double slash)", "/repos/acme/widgets/pulls/1//merge"],
    ["trailing slash", "/repos/acme/widgets/pulls/1/merge/"],
    ["embedded query string", "/repos/acme/widgets/pulls/1/merge?x=1"],
    ["embedded fragment", "/repos/acme/widgets/pulls/1/merge#frag"],
    ["backslash", "/repos/acme/widgets/pulls/1\\merge"],
    ["percent-encoded dot (%2e)", "/repos/acme/widgets/pulls/%2e%2e/pulls/1/merge"],
    ["percent-encoded dot uppercase (%2E)", "/repos/acme/widgets/pulls/%2E%2E/pulls/1/merge"],
    ["percent-encoded slash (%2f)", "/repos/acme/widgets%2fpulls/1/merge"],
    ["percent-encoded backslash (%5c)", "/repos/acme/widgets%5c..%5cmerge"],
  ])("rejects: %s (%s)", (_label, path) => {
    expect(isCanonicalPath(path)).toBe(false);
  });

  it("rejects a bare dot as the whole path segment set", () => {
    expect(isCanonicalPath("/.")).toBe(false);
  });

  it("rejects a bare dot-dot segment", () => {
    expect(isCanonicalPath("/..")).toBe(false);
  });

  // [H03 fix round 2, item E1] Control characters and whitespace, literal
  // (not percent-encoded) — a naive charset omission let these through, and
  // `new URL()` (or any real HTTP client) normalizes a tab out of a path
  // before making the actual request.
  it.each([
    ["a literal tab mid-segment", "/repos/acme/widgets/pulls/1/mer\tge"],
    ["a tab-padded dot segment", "/repos/acme/widgets/pulls/.\t./pulls/1/merge"],
    ["a trailing space", "/repos/acme/widgets/pulls/1/merge "],
    ["a leading space", "/repos/acme/widgets/pulls/ 1/merge"],
    ["a DEL character (0x7F)", "/repos/acme/widgets/pulls/1/merge\x7f"],
    ["a newline", "/repos/acme/widgets/pulls/1/merge\n"],
    ["a NUL character", "/repos/acme/widgets/pulls/1/merge\0"],
  ])("[E1] rejects: %s (%s)", (_label, path) => {
    expect(isCanonicalPath(path)).toBe(false);
  });

  // [H03 fix round 2, item W2]
  it.each([
    ["percent-encoded lowercase letter (%6d = 'm')", "/repos/acme/widgets/pulls/1/%6derge"],
    ["percent-encoded digit (%31 = '1')", "/repos/acme/widgets/pulls/%31/merge"],
    ["percent-encoded uppercase letter (%41 = 'A')", "/repos/acme/widgets/pulls/%41cme/merge"],
    ["percent-encoded hyphen (%2d = '-')", "/repos/acme%2dwidgets/pulls/1/merge"],
    ["percent-encoded underscore (%5f = '_')", "/repos/acme_widgets%5ftest/pulls/1/merge"],
    ["percent-encoded tilde (%7e = '~')", "/repos/acme/widgets/pulls/1/merge%7e"],
    ["double-encoded percent (%2520 -> %20 -> space)", "/repos/acme/widgets/pulls/1/merge%2520"],
    ["double-encoded dot-dot (%252e%252e)", "/repos/acme/widgets/pulls/%252e%252e/pulls/1/merge"],
    ["semicolon path-parameter delimiter", "/repos/acme/widgets/pulls/1/merge;x"],
    ["percent-encoded semicolon (%3b)", "/repos/acme/widgets/pulls/1/merge%3bx"],
    ["overlong UTF-8 dot (%c0%ae)", "/repos/acme/widgets/pulls/%c0%ae%c0%ae/pulls/1/merge"],
    ["literal fullwidth dot (U+FF0E)", "/repos/acme/widgets/pulls/．．/pulls/1/merge"],
    ["percent-encoded space (%20, still control-range)", "/repos/acme/widgets/pulls/1/merge%20"],
    ["malformed escape (not 2 hex digits)", "/repos/acme/widgets/pulls/1/merge%2"],
    ["malformed escape (non-hex)", "/repos/acme/widgets/pulls/1/merge%zz"],
  ])("[W2] rejects: %s (%s)", (_label, path) => {
    expect(isCanonicalPath(path)).toBe(false);
  });

  it("[W2] does not force-lowercase an owner or repo name — only fixed API keywords", () => {
    expect(isCanonicalPath("/repos/Acme/Widgets")).toBe(true);
    expect(isCanonicalPath("/repos/ACME-Corp/My-Repo")).toBe(true);
  });

  it("[W2] a sub-delim byte that is neither unreserved nor a separator may still be percent-encoded", () => {
    // '(' and ')' are already legal LITERAL characters in a segment (they're
    // in SEGMENT_CHARSET_RE), so encoding them is redundant but not one of
    // the specific bypass shapes this function guards against (it isn't
    // unreserved, isn't '/'/'\\'/';', isn't '%', isn't a control/space/DEL/
    // non-ASCII byte). Documented here so it reads as a deliberate boundary
    // of the allowlist, not an oversight.
    expect(isCanonicalPath("/repos/acme/widgets/pulls/1/merge%28x%29")).toBe(true);
  });

  // [H03 fix round 3, item W4] '#' and '?' split a URL into path/query/
  // fragment. Both were already rejected LITERALLY (see the top-level
  // includes("?")/includes("#") checks), but their percent-encoded
  // spellings previously sailed through unblocked — neither is unreserved,
  // neither is '/'/'\\'/';'/'%', so nothing else on the forbidden-byte list
  // caught them.
  it.each([
    ["percent-encoded '?' (%3f)", "/repos/acme/widgets/pulls/1/merge%3f"],
    ["percent-encoded '?' uppercase hex (%3F)", "/repos/acme/widgets/pulls/1/merge%3F"],
    ["percent-encoded '#' (%23)", "/repos/acme/widgets/pulls/1/merge%23frag"],
  ])("[W4] rejects: %s (%s)", (_label, path) => {
    expect(isCanonicalPath(path)).toBe(false);
  });

  // [H03 fix round 3, suggestion] Keyword casing is no longer checked here
  // at all — a case-insensitive scan over every segment, with no notion of
  // position, over-denied real content that merely collides with a
  // keyword's spelling: a repo file literally named `Keys`, a branch
  // literally named `Refs`. Both must be accepted here now; the actual
  // keyword-position enforcement lives in each case-sensitive regex at its
  // own decision point (see decide.security.test.ts's "[round 3] suggestion"
  // block for evidence that a real wrong-case merge attempt is still
  // denied, just later and more precisely).
  it.each([
    "/repos/acme/widgets/contents/docs/Keys",
    "/repos/acme/widgets/branches/Refs",
    "/repos/acme/widgets/contents/Info",
    "/repos/acme/widgets/contents/Merge.md",
  ])("[round 3] accepts a real content/branch/file name that merely collides with a keyword's spelling: %s", (path) => {
    expect(isCanonicalPath(path)).toBe(true);
  });
});
