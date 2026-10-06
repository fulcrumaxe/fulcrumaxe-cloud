import { describe, expect, it } from "vitest";
import { redactDeep, TELEMETRY_SHAPES, TOKEN_SHAPE_PATTERN_SOURCES } from "@fx/runtime/src/redact.js";

/**
 * CWE-1333: no pattern may go super-linear. Each pattern is run ALONE (so the chunked scan
 * in redactShapes cannot hide a slow regex) over 256k characters built from every
 * pattern's trigger text, and must finish inside a fixed bound.
 */
const N = 256 * 1024;
const BOUND_MS = 500; // generous: the parallel suite shares the CPU; a quadratic pattern takes seconds per input
const MIB = 1024 * 1024;
const MIB_BOUND_MS = 5000;

const TRIGGERS = [
  "eyJ", "eyJa.", "eyJa.b.", "postgres://", "postgresql://a:", "postgres://a@", "token=", "token:", "Bearer ", "Bearer",
  "Authorization:", "authorization: token ", "cookie=", "Set-Cookie: ", "://", "://a:", "sk-", "sk-proj-", "key", "KEY", "PASS",
  "KEY_", "?key=", "&a=", "xoxb-", "xoxp-", "vck_", "vcp_", "sk-ant-", "sk_live_", "rk_test_", "whsec_", "fxat_",
  "__Host-fx_session=", "GH_TOKEN=", "AKIA", "ghp_", "github_pat_", "x-access-token:", "a", "0", "-", "_", ".", "=", "@", " ",
  // OPS-T1c: repeated labels, Bearer chains, "a: a: a:", letter runs, backslash runs, camel and upper-case names.
  "Bearer Bearer ", "a: a: ", "x-auth-token: ", "password: ", "apiKey", "DBPASS=", "://:", "a b ", "abcdefghijklmnopqrstuvwxyz",
  "\\\\\\\\\\\\\\\\\\\\", '"password":"', '\\"apiKey\\":\\"', '\\\\\\"authorization\\\\\\":\\\\\\"', "aB_cD.eF-gH",
  "key_", "KEY_", "keyKey", "password=\"", "password: '", "token_count=", "SECRET_KEY_BASE=", "a_password=", "-password: ", "OAuth ", "Bot ",
  "password='\n", 'password: "a\n', "password = ", 'private_key="\n', "password=\"'\n\\\"",
];

const inputs: Array<[string, string]> = [];
for (const unit of TRIGGERS) {
  inputs.push([`${JSON.stringify(unit)} repeated`, unit.repeat(Math.ceil(N / unit.length)).slice(0, N)]);
  inputs.push([`${JSON.stringify(unit)} then a long space run`, unit + " ".repeat(N)]);
  inputs.push([`${JSON.stringify(unit)} then a long token run`, unit + "a".repeat(N)]);
}

const patterns: Array<[string, string, string]> = [
  ...TOKEN_SHAPE_PATTERN_SOURCES.map((source, i): [string, string, string] => [`token-shape-${i}`, source, "g"]),
  ...TELEMETRY_SHAPES.map((shape): [string, string, string] => [shape.name, shape.source, shape.flags]),
];

describe("every pattern is linear on pathological 256k inputs", () => {
  for (const [name, source, flags] of patterns) {
    it(`${name} finishes each input in under ${BOUND_MS} ms`, () => {
      const slow: string[] = [];
      for (const [label, input] of inputs) {
        const re = new RegExp(source, flags);
        const t0 = performance.now();
        input.replace(re, "[redacted]");
        const ms = performance.now() - t0;
        if (ms > BOUND_MS) slow.push(`${label}: ${ms.toFixed(0)} ms`);
      }
      expect(slow).toEqual([]);
    }, 60_000);
  }

  it("redactDeep over 1 MiB inputs, all patterns together, stays inside the bound", () => {
    const slow: string[] = [];
    for (const unit of TRIGGERS) {
      for (const input of [unit.repeat(Math.ceil(MIB / unit.length)).slice(0, MIB), unit + "a".repeat(MIB)]) {
        const t0 = performance.now();
        expect(redactDeep(input, []).length).toBeGreaterThan(0);
        const ms = performance.now() - t0;
        if (ms > MIB_BOUND_MS) slow.push(`${JSON.stringify(unit)}: ${ms.toFixed(0)} ms`);
      }
    }
    expect(slow).toEqual([]);
  }, 120_000);

  it("redactDeep over the same inputs, all patterns together, stays inside the bound", () => {
    const slow: string[] = [];
    for (const [label, input] of inputs) {
      const t0 = performance.now();
      redactDeep(input, []);
      const ms = performance.now() - t0;
      if (ms > BOUND_MS * 4) slow.push(`${label}: ${ms.toFixed(0)} ms`);
    }
    expect(slow).toEqual([]);
  }, 60_000);
});
