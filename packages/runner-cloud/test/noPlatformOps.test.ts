import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.join(__dirname, "..", "src");
const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
/** The source with comments removed, so a sentence about platform_ops is not mistaken for code that uses it. */
const code = (file: string): string => readFileSync(path.join(SRC, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("@fx/runner-cloud never holds the platform_ops login (0724)", () => {
  it("has source files to scan", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("names no platform_ops pool or connection setting", () => {
    for (const file of files) expect(code(file), file).not.toMatch(/platformOps|platform_ops|PLATFORM_OPS/);
  });

  it("writes no runner table directly: every change goes through a runner_* function", () => {
    for (const file of files) {
      expect(code(file), file).not.toMatch(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(public\.)?runner/i);
    }
  });
});
