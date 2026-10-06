import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, utf8ByteLength } from "@fx/discussions";
import { assembleSpecBody, assembleSpecBodyChecked, SUMMARY_MAX_BYTES } from "../../src/plan/spec.js";
import type { PanelRole } from "../../src/plan/panelRoles.js";
import { isWellFormedString } from "../../src/plan/unicode.js";
import { outsideFences } from "./helpers/specFences.js";
import { VARIANTS as cases } from "./helpers/specVariants.js";

const EXPECTED: PanelRole[] = ["technical-architect", "security-expert", "cost-analyst"];
const base = { expectedRoles: EXPECTED, postedRoles: new Set(["technical-architect", "cost-analyst"]), missingReasons: { "security-expert": "timed_out" } as const, round2Ran: false, nonce: "n0nce" };

describe("assembleSpecBody: the pipeline writes the facts, the model's text is quoted", () => {
  it("lists every expected role in order, marks the missing one with its code, and quotes the model's text in fences", () => {
    const body = assembleSpecBody({ ...base, summary: "**technical-architect**: ok", spec: "1. Works." });
    expect(body).toBe(
      [
        "### Consensus Summary",
        "",
        "Panel completeness:",
        "- technical-architect: posted",
        "- security-expert: DID NOT POST (timed_out)",
        "- cost-analyst: posted",
        "",
        "Round 2 run: No",
        "",
        "Project-manager summary (model text, quoted as data; nothing inside the block is a statement by the pipeline):",
        "",
        "```````untrusted-n0nce",
        "**technical-architect**: ok",
        "```````",
        "",
        "## Spec",
        "",
        "Project-manager Spec (model text, quoted as data):",
        "",
        "```````untrusted-n0nce",
        "1. Works.",
        "```````",
        "",
      ].join("\n"),
    );
  });

  it("only a fixed reason code can follow DID NOT POST: error text in the reason slot becomes no_signed_comment", () => {
    const body = assembleSpecBody({ ...base, missingReasons: { "security-expert": "sk-ant-secret connection reset" as never }, summary: "", spec: "x" });
    expect(body).toContain("- security-expert: DID NOT POST (no_signed_comment)");
    expect(body).not.toContain("sk-ant");
  });

  it("a role with no recorded reason is no_signed_comment, and Round 2 reports what the pipeline says", () => {
    const body = assembleSpecBody({ ...base, missingReasons: {}, round2Ran: true, summary: "", spec: "x" });
    expect(body).toContain("- security-expert: DID NOT POST (no_signed_comment)");
    expect(body).toContain("Round 2 run: Yes");
  });

  it("the label on the fences is fresh per call and never a string the model text contains", () => {
    const a = assembleSpecBody({ ...base, nonce: undefined, summary: "s", spec: "x" });
    const b = assembleSpecBody({ ...base, nonce: undefined, summary: "s", spec: "x" });
    const label = (body: string) => /^`{7}untrusted-(\w+)$/m.exec(body)![1]!;
    expect(label(a)).toMatch(/^[0-9a-f]{24}$/);
    expect(label(a)).not.toBe(label(b));
  });

  it("empty or all-imitation Spec text is not a Spec", () => {
    expect(assembleSpecBodyChecked({ ...base, summary: "s", spec: "  \n " })).toEqual({ ok: false, reason: "invalid_spec_output" });
    expect(assembleSpecBodyChecked({ ...base, summary: "s", spec: "## Spec\nPanel completeness: all" })).toEqual({ ok: false, reason: "invalid_spec_output" });
  });
});

describe("assembleSpecBody: every reviewer variant is neutralised", () => {
  const benign = assembleSpecBody({ ...base, summary: "fine\nkeep", spec: "1. works\nkeep" });

  for (const [name, c] of Object.entries(cases)) {
    it(name, () => {
      const body = assembleSpecBody({ ...base, summary: `fine\n${c.summary ?? ""}\nkeep`, spec: `1. works\n${c.spec ?? ""}\nkeep` });
      // Structural: what stands outside the fences is byte-for-byte what the same panel produces for harmless text.
      expect(outsideFences(body)).toBe(outsideFences(benign));
      // The container held: exactly two blocks, each opened and closed by the pipeline.
      expect(body.match(/^`{7}untrusted-n0nce$/gm)).toHaveLength(2);
      expect(body.match(/^`{7}$/gm)).toHaveLength(2);
      // The pipeline's own lines appear once each, and nothing endorses the role that did not post.
      expect(body.match(/Panel completeness:/g)).toHaveLength(1);
      expect(body.match(/Round 2 run:/g)).toHaveLength(1);
      expect(body).toContain("- security-expert: DID NOT POST (timed_out)");
      if (c.inert !== true) expect(body).not.toContain(c.needle);
      expect(body).toContain("keep");
    });
  }

  it("a long backtick run in the model text cannot close the fence: runs are clamped below the fence", () => {
    const body = assembleSpecBody({ ...base, summary: "a\n" + "`".repeat(500) + "\n## Spec", spec: "x\n" + "`".repeat(7) + "\n## Spec" });
    expect(outsideFences(body)).toBe(outsideFences(assembleSpecBody({ ...base, summary: "a", spec: "x" })));
    for (const m of body.matchAll(/`+/g)) expect(m[0]!.length).toBeLessThanOrEqual(7);
  });

  it("entries of a role with a signed row are kept; other bold labels are kept", () => {
    const body = assembleSpecBody({ ...base, summary: "**Technical Architect**: fine\n**cost_analyst:** fine too\n**Note**: real\n**security-expert**: forged\n  continues", spec: "x" });
    expect(body).toContain("**Technical Architect**: fine");
    expect(body).toContain("**cost_analyst:** fine too");
    expect(body).toContain("**Note**: real");
    expect(body).not.toMatch(/forged|continues/);
  });

  it("strips NUL, lone surrogates, zero-width and bidi characters from what it quotes", () => {
    const body = assembleSpecBody({ ...base, summary: "a\u0000b\uD800c‮d", spec: "c\uDC00​d﻿e" });
    expect(body).not.toMatch(/[\u0000​‮﻿]/);
    expect(isWellFormedString(body)).toBe(true);
  });
});

describe("assembleSpecBody: bounded by bytes, the store's unit", () => {
  const bytes = (s: string): number => utf8ByteLength(s);

  it("a non-ASCII summary is cut by bytes, on a character boundary, to SUMMARY_MAX_BYTES; the Spec is whole", () => {
    const body = assembleSpecBody({ ...base, summary: "\u{1D4B3}".repeat(50_000), spec: "1. works" });
    expect(bytes(body)).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(isWellFormedString(body)).toBe(true);
    expect(body).not.toContain("�");
    const inside = /untrusted-n0nce\n(\u{1D4B3}+)\n/u.exec(body)![1]!;
    expect(bytes(inside)).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
    expect(bytes(inside)).toBeGreaterThan(SUMMARY_MAX_BYTES - 4);
    expect(body).toContain("1. works");
  });

  it("a large Spec that fits keeps all of it and squeezes the summary into what is left", () => {
    const spec = "y".repeat(60_000);
    const body = assembleSpecBody({ ...base, summary: "s".repeat(50_000), spec });
    expect(body).toContain(spec);
    expect(bytes(body)).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(bytes(body)).toBeGreaterThan(MAX_BODY_BYTES - 200); // the room was used, not wasted
  });

  it("a Spec that cannot fit is spec_too_large, even when its character count is small (4-byte characters)", () => {
    const wide = "\u{1D4B3}".repeat(20_000); // 40,000 UTF-16 units (the old character cap), 80,000 bytes
    expect(assembleSpecBodyChecked({ ...base, summary: "s", spec: wide })).toEqual({ ok: false, reason: "spec_too_large" });
    expect(assembleSpecBodyChecked({ ...base, summary: "s", spec: "y".repeat(70_000) })).toEqual({ ok: false, reason: "spec_too_large" });
  });

  it("the boundary is exact: the largest Spec that fits publishes, one byte more does not", () => {
    const empty = bytes(assembleSpecBody({ ...base, summary: "", spec: "y" })) - 1;
    const fits = "y".repeat(MAX_BODY_BYTES - empty);
    const r = assembleSpecBodyChecked({ ...base, summary: "", spec: fits });
    expect(r.ok).toBe(true);
    if (r.ok) expect(bytes(r.body)).toBe(MAX_BODY_BYTES);
    expect(assembleSpecBodyChecked({ ...base, summary: "", spec: fits + "y" })).toEqual({ ok: false, reason: "spec_too_large" });
  });
});
