import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE_CSS = path.join(HERE, "..", "src", "css", "base.css");

describe("base.css motion and skip link (K03a)", () => {
  it("resets transitions and animations under prefers-reduced-motion: reduce", async () => {
    const css = await fs.readFile(BASE_CSS, "utf-8");
    const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toContain("transition-duration");
    expect(block![0]).toContain("animation-duration");
    expect(block![0]).toContain("animation-iteration-count: 1");
  });

  it("styles .skip-link, shown on focus", async () => {
    const css = await fs.readFile(BASE_CSS, "utf-8");
    expect(css).toContain(".skip-link {");
    expect(css).toContain(".skip-link:focus");
  });
});
