import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

// Any of these appearing in a src/**/*.ts import/require is a purity
// violation for this package: filesystem access, network access, or a
// model/AI-SDK call. gateSite and assertRenderable must only ever look at
// the SiteContent object handed to them.
const FORBIDDEN_PREFIXES = [
  "fs",
  "node:fs",
  "http",
  "node:http",
  "https",
  "node:https",
  "net",
  "node:net",
  "dns",
  "node:dns",
  "dgram",
  "node:dgram",
  "child_process",
  "node:child_process",
  "worker_threads",
  "node:worker_threads",
  "@anthropic-ai/sdk",
  "openai",
  "undici",
  "node-fetch",
  "axios",
];

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importRe = /(?:import|export)\s+(?:[^'"]*?\bfrom\s+)?['"]([^'"]+)['"]/g;
  const requireRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [importRe, requireRe]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

describe("purity — pass/fail item 6 (no fs, network, or model imports)", () => {
  const files = listSourceFiles(srcDir);

  it("found at least one source file to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file.replace(srcDir, "src")} imports nothing from the forbidden list`, () => {
      const source = readFileSync(file, "utf8");
      const specifiers = importSpecifiers(source);
      const offenders = specifiers.filter((spec) =>
        FORBIDDEN_PREFIXES.some((prefix) => spec === prefix || spec.startsWith(`${prefix}/`)),
      );
      expect(offenders).toEqual([]);
    });
  }

  it("goes red on a deliberately impure fixture (demonstrates the scan actually catches fs/network/model imports)", () => {
    const impureSource = `import { readFileSync } from "node:fs";\nimport OpenAI from "openai";\n`;
    const specifiers = importSpecifiers(impureSource);
    const offenders = specifiers.filter((spec) =>
      FORBIDDEN_PREFIXES.some((prefix) => spec === prefix || spec.startsWith(`${prefix}/`)),
    );
    expect(offenders).toEqual(["node:fs", "openai"]);
  });
});
