import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import baseCss from "../src/css/baseCss.json" with { type: "json" };
import { BASE_CSS, getBaseCss } from "../src/css/index.js";
// @ts-expect-error the generator is a plain .mjs with no types
import { CSS_PATH, JSON_PATH, renderBaseCss } from "../scripts/generate-base-css.mjs";

describe("the generated base stylesheet", () => {
  it("the committed baseCss.json is exactly what the generator makes from base.css (drift fails here)", () => {
    expect(readFileSync(JSON_PATH as string, "utf8")).toBe(renderBaseCss() as string);
  });

  it("getBaseCss returns the text of base.css byte for byte", () => {
    const onDisk = readFileSync(CSS_PATH as string, "utf8");
    expect(BASE_CSS).toBe(onDisk);
    expect(getBaseCss()).toBe(onDisk);
    expect(baseCss).toBe(onDisk);
  });
});
