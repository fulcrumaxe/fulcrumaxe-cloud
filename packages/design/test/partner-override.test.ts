import { describe, expect, it } from "vitest";
import { TOKEN_SETS } from "../src/css/tokens.js";
import { PartnerOverride, applyPartnerOverride } from "../src/schema/tokenSet.js";

/**
 * D#2 spec amendment pass/fail item 6 — white-label hook for D#4 P03.
 * `renderTokens(set)` already exists (see token-swap.test.ts); this covers
 * the other half: the documented partner-override schema, which keys a
 * partner may override (colours, minus the semantic constants) and which
 * are structural and fixed (spacing, type scale, radius, container width,
 * and — per the D#2 H24 criterion 2/6 ruling,
 * D#2 comment 18505329
 * — the four `SEMANTIC_CONSTANT_KEYS` colours).
 */
describe("partner-override schema (D#2 spec amendment item 6)", () => {
  it("accepts a partial set of colour overrides", () => {
    const override = PartnerOverride.parse({ accent: "#ff0055", bg: "#111111" });
    expect(override).toEqual({ accent: "#ff0055", bg: "#111111" });
  });

  it("accepts an empty override (a partner who changes nothing)", () => {
    expect(PartnerOverride.parse({})).toEqual({});
  });

  it("rejects a key that is not one of the twelve overridable colour tokens", () => {
    expect(() => PartnerOverride.parse({ notAToken: "#ffffff" })).toThrow();
  });

  it("rejects an attempt to override a structural key (spacing)", () => {
    expect(() => PartnerOverride.parse({ spacing: { md: "2rem" } })).toThrow();
  });

  it("rejects an attempt to override a structural key (radius)", () => {
    expect(() => PartnerOverride.parse({ radius: "20px" })).toThrow();
  });

  it("rejects an attempt to override a structural key (container.max)", () => {
    expect(() => PartnerOverride.parse({ container: { max: "80rem" } })).toThrow();
  });

  it("rejects an attempt to override a semantic-constant colour (danger) — D#2 H24 criterion 6 ruling", () => {
    expect(() => PartnerOverride.parse({ danger: "#ff0000" })).toThrow();
  });

  it("applyPartnerOverride replaces only the overridden colours, leaving spacing/type/radius/container untouched", () => {
    const base = TOKEN_SETS.terminal;
    const branded = applyPartnerOverride(base, { accent: "#ff0055" });
    expect(branded.colors.accent).toBe("#ff0055");
    expect(branded.colors.bg).toBe(base.colors.bg); // untouched
    expect(branded.spacing).toEqual(base.spacing); // structural, untouched
    expect(branded.type).toEqual(base.type); // structural, untouched
    expect(branded.radius).toBe(base.radius); // structural, untouched
    expect(branded.container).toEqual(base.container); // structural, untouched
  });

  it("applyPartnerOverride throws on an invalid override rather than silently merging it", () => {
    const base = TOKEN_SETS.terminal;
    // @ts-expect-error — deliberately invalid input, proving the runtime guard fires
    expect(() => applyPartnerOverride(base, { radius: "999px" })).toThrow();
  });
});
