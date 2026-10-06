import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(HERE, "..", "src");

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/**
 * D#2606 K03 pass/fail item 4: `grep -ri "fulcrumaxe" packages/sitekit-template/src`
 * finds no match outside the credit footer string. No "Claude Code" string
 * anywhere.
 */
describe("branding (D#2606 K03 item 4)", () => {
  it("mentions fulcrumaxe only in the credit footer string", () => {
    const offenders: string[] = [];
    for (const file of listFiles(SRC_DIR)) {
      const text = fs.readFileSync(file, "utf-8");
      for (const line of text.split("\n")) {
        if (/fulcrumaxe/i.test(line) && !/Built with fulcrumaxe site kit/.test(line)) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("never mentions Claude Code", () => {
    const offenders: string[] = [];
    for (const file of listFiles(SRC_DIR)) {
      const text = fs.readFileSync(file, "utf-8");
      if (/claude code/i.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
