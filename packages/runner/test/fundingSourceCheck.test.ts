import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX_TARGET_FILE = path.join(__dirname, "..", "src", "targets", "sandboxTarget.ts");

/**
 * D#2 H09b2, correction C16.4: "Source check (comments stripped): in
 * `src/targets/sandboxTarget.ts`, no call to `reserve(`, `release(`,
 * `settle(`, `meter(`, `meterCompute(` or `modelConnection.get(` has
 * `run.accountId` in its argument list."
 *
 * A line-based scan, not a full parser: every call site in this file is
 * written on one line (or the `run.accountId` argument would be), which
 * every real call site in the file today is.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const CALLS = ["reserve(", "release(", "settle(", "meter(", "meterCompute(", "modelConnection.get("];

describe("C16.4 source check: sandboxTarget.ts never passes run.accountId to a spend/key call", () => {
  it("no line calling reserve/release/settle/meter/meterCompute/modelConnection.get contains run.accountId", () => {
    const lines = stripComments(readFileSync(SANDBOX_TARGET_FILE, "utf8")).split("\n");
    const offenders: string[] = [];
    for (const line of lines) {
      if (CALLS.some((call) => line.includes(call)) && line.includes("run.accountId")) {
        offenders.push(line.trim());
      }
    }
    expect(offenders).toEqual([]);
  });
});
