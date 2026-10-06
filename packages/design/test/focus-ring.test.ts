import { describe, expect, it } from "vitest";
import { getBaseCss } from "../src/css/index.js";

/**
 * Review SHOULD-FIX on PR #39 (D#2 H24): `.cta:focus-visible` must show a
 * visible, token-driven focus ring — not only the faint background wash it
 * shares with `:hover` — and must never ship `outline: none` without a
 * real replacement. A mouse hover has other cues (the pointer itself); a
 * keyboard/AT user focusing the button has only the CSS at this selector,
 * so `:focus-visible` needs its own, stronger rule.
 */
describe("cta focus-visible ring", () => {
  it("gives .cta:focus-visible its own rule, separate from :hover", () => {
    const css = getBaseCss();
    // A combined ".cta:hover,\n.cta:focus-visible {" selector is exactly the
    // bug: it means focus gets nothing hover doesn't already have.
    expect(css).not.toMatch(/\.cta:hover\s*,\s*\.cta:focus-visible\s*\{/);
    expect(css).toMatch(/\.cta:focus-visible\s*\{/);
  });

  it("gives .cta:focus-visible a visible, token-driven ring alongside outline:none", () => {
    const css = getBaseCss();
    const match = css.match(/\.cta:focus-visible\s*\{([^}]*)\}/);
    expect(match, ".cta:focus-visible rule not found").not.toBeNull();
    const body = match![1];

    // outline: none is only acceptable here because box-shadow replaces it —
    // assert the replacement exists, not just that outline is silenced.
    expect(body).toMatch(/outline:\s*none/);
    expect(body).toMatch(/box-shadow:\s*[^;]*var\(--(accent|danger|warn|fg)[a-z-]*\)/);

    // The ring must be built from a token, not a raw literal. The shared
    // hardcoded-value guard (hardcoded-guard.test.ts) already forbids a raw
    // hex colour anywhere in this file; this assertion pins that same
    // requirement directly to the focus-visible rule so a future edit that
    // widens the guard's allowlist can't quietly reintroduce a literal here.
    expect(body).not.toMatch(/box-shadow:\s*[^;]*#[0-9a-fA-F]{3,8}/);
  });
});
