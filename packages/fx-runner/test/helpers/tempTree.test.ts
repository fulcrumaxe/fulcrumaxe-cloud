import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { removeTree, tempDir } from "./tempTree.js";

describe("tempTree", () => {
  it("removes a tree whose directories were closed (chmod 0) and never follows a link out of it", () => {
    const outside = tempDir("fx-tt-outside-");
    writeFileSync(path.join(outside, "keep"), "x");
    const root = tempDir("fx-tt-");
    const deep = path.join(root, "a", "b");
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(deep, "f"), "x");
    symlinkSync(outside, path.join(root, "a", "link"));
    for (const dir of [deep, path.join(root, "a")]) chmodSync(dir, 0);
    removeTree(root);
    expect(existsSync(root)).toBe(false);
    expect(existsSync(path.join(outside, "keep"))).toBe(true);
  });

  it("is not an error when the directory is already gone", () => {
    const root = tempDir("fx-tt-gone-");
    removeTree(root);
    expect(() => removeTree(root)).not.toThrow();
  });
});
