import { describe, expect, it } from "vitest";
import { redactDeep, redactShapes, redactText } from "../src/redact.js";

/** Fixtures that look like credentials are assembled at run time, so no literal token-shaped string sits in this tree. */
const t = (...parts: string[]): string => parts.join("");
const TAIL = t("Zq81", "XyPw", "0kLm", "N3");
const LONG_TAIL = t(TAIL, TAIL, TAIL);

describe("G2: redaction of credential shapes", () => {
  const cases: Array<[string, string]> = [
    ["sk-ant-oat01-", t("sk-ant-", "oat01-", LONG_TAIL)],
    ["sk-ant-api03-", t("sk-ant-", "api03-", LONG_TAIL)],
    ["sk-ant-admin01-", t("sk-ant-", "admin01-", LONG_TAIL)],
    ["invented sk-ant-zzz42-", t("sk-ant-", "zzz42-", LONG_TAIL)],
    ["invented sk-ant-zzz42- with a short tail", t("sk-ant-", "zzz42-", "AbCdEfGhIj")],
    ["sk-ant with a three-letter kind and no digits", t("sk-ant-", "xyz-", "AbCdEfGhIjK")],
    ["ghs_", t("gh", "s_", LONG_TAIL)],
    ["ghp_", t("gh", "p_", LONG_TAIL)],
    ["ghs_ with a short tail", t("gh", "s_", "AbCdEfGhIj")],
    ["github_pat_", t("github", "_pat_", LONG_TAIL, "_x")],
    ["fxrr_", t("fx", "rr_", LONG_TAIL)],
    ["fxrr_ with a short tail", t("fx", "rr_", "AbCdEfGhIj")],
    ["fxat_", t("fx", "at_", LONG_TAIL)],
    ["whsec_", t("wh", "sec_", LONG_TAIL)],
    ["a JWT-shaped string", t("ey", "J", "hbGciOiJFZERTQSJ9", ".", "ey", "J", "zdWIiOiJ4In0", ".", "c2ln", "bmF0dXJl")],
  ];

  for (const [name, secret] of cases) {
    it(`removes ${name}`, () => {
      for (const text of [secret, `value: ${secret} end`, `{"k":"${secret}"}`, `x=${secret}\nnext line`]) {
        const out = redactText(text, []);
        expect(out, text).not.toContain(secret);
        expect(out, text).not.toContain(TAIL);
        expect(out).toContain("[redacted]");
      }
    });
  }

  it("removes an Authorization: Bearer header value, and a bare Bearer value", () => {
    const token = t("opaque", "-", LONG_TAIL);
    const header = redactText(`Authorization: Bearer ${token}\nContent-Type: text/plain`, []);
    expect(header).not.toContain(token);
    expect(header).toContain("Content-Type: text/plain");
    const bare = redactText(`curl -H 'x' then Bearer ${token} was sent`, []);
    expect(bare).not.toContain(token);
    expect(redactText(`Authorization: ${token}`, [])).not.toContain(token);
  });

  it("leaves ordinary prose and short identifiers alone", () => {
    for (const text of ["the task-force met", "sk-ant is a prefix", "branch fx/abc-g1", "Bearer of good news and glad tidings", "ghs is short", "fxrr was a code name"]) {
      expect(redactText(text, []), text).toBe(text);
    }
  });

  it("redacts every string inside a nested structure, and exact known values", () => {
    const secret = t("sk-ant-", "zzz42-", "AbCdEfGhIj");
    const out = redactDeep({ a: [secret, { b: `x ${secret}` }], c: "exact-known-value-123" }, ["exact-known-value-123"]);
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(JSON.stringify(out)).not.toContain("exact-known-value-123");
  });

  it("applies to a very long string without dropping anything around the secret", () => {
    const secret = t("fx", "rr_", LONG_TAIL);
    const filler = "word ".repeat(40_000);
    const out = redactShapes(`${filler}${secret} ${filler}`);
    expect(out).not.toContain(secret);
    expect(out.length).toBeGreaterThan(filler.length * 2 - 10);
  });
});
