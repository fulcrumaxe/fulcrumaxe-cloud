// No login of the owner or of the team's bot is written anywhere in this package: accounts are parameters, never code.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "./helpers.js";

const NAMES = [["john", "problems"].join(""), ["autonomous", "agent", "7"].join("-")];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === "node_modules" ? [] : e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

describe("no account name in apps/live-e2e", () => {
  it("finds none in any file of the package", () => {
    const all = files(PACKAGE_ROOT);
    expect(all.length).toBeGreaterThan(50);
    for (const f of all) {
      const text = readFileSync(f, "utf8");
      for (const name of NAMES) expect(text.toLowerCase().includes(name), `${f} names an account`).toBe(false);
    }
  });
});
