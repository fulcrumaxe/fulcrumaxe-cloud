import { describe, expect, it } from "vitest";
import { selectPanel } from "../../src/plan/panelRoles.js";

const TA = "technical-architect";
const CRITICAL_TRIPLE = [TA, "security-expert", "cost-analyst"];
const FEATURE_TRIPLE = [TA, "product-owner", "performance-expert"];

describe("selectPanel: the triple is chosen by the item's kind (C41 section 1)", () => {
  it("H15c-PANEL 1: a critical item whose text has only performance and UI words is seated TA + security-expert + cost-analyst, plus ux-designer for the UI word", () => {
    expect(selectPanel("critical", "Faster startup", "reduce latency and memory when the user opens the settings screen")).toEqual([...CRITICAL_TRIPLE, "ux-designer"]);
    // the performance words alone add nobody and remove nobody
    expect(selectPanel("critical", "Faster startup", "reduce latency and memory")).toEqual(CRITICAL_TRIPLE);
  });

  it("H15c-PANEL 2: a feature item whose text has only security and cost words is seated TA + product-owner + performance-expert", () => {
    expect(selectPanel("feature", "Rotate credentials", "the secret token and permission live on the cloud server; mind the quota and rate limit")).toEqual(FEATURE_TRIPLE);
  });

  it("H15c-PANEL 3: a critical and a feature item with no keyword match get their own kind's triple", () => {
    expect(selectPanel("critical", "Tidy", "nothing to see")).toEqual(CRITICAL_TRIPLE);
    expect(selectPanel("feature", "Tidy", "nothing to see")).toEqual(FEATURE_TRIPLE);
  });

  const TEXTS: Array<[string, string, string]> = [
    ["empty", "", ""],
    ["security-heavy", "auth token secret", "permission credentials inject eval XSS privacy sensitive"],
    ["performance-heavy", "latency", "slow memory leak bundle startup timer interval drift"],
    ["UI-heavy", "UI popup", "button overlay layout screen wireframe display UX"],
    ["external-dependency-heavy", "npm package", "library sdk mcp cargo pip RFC W3C API"],
    ["all of them", "auth latency UI npm", "token slow button library secret memory overlay sdk cloud quota"],
  ];

  it.each(["critical", "feature"] as const)("H15c-PANEL 4: for %s, over a table of texts, the kind's three triple seats are always present, first and in order", (kind) => {
    const triple = kind === "critical" ? CRITICAL_TRIPLE : FEATURE_TRIPLE;
    expect(TEXTS.length).toBeGreaterThanOrEqual(6);
    for (const [name, title, body] of TEXTS) {
      const roles = selectPanel(kind, title, body);
      expect(roles.slice(0, 3), name).toEqual(triple);
      expect(roles.length, name).toBeLessThanOrEqual(5);
      expect(new Set(roles).size, name).toBe(roles.length);
    }
  });

  it("H15c-PANEL 5: an external-dependency word adds the researcher, a UI word adds the ux-designer, and neither is ever added twice", () => {
    expect(selectPanel("feature", "Add an npm package", "wire the sdk")).toEqual([...FEATURE_TRIPLE, "researcher"]);
    expect(selectPanel("critical", "New popup layout", "a button and a wireframe")).toEqual([...CRITICAL_TRIPLE, "ux-designer"]);
    const both = selectPanel("feature", "New popup layout", "a button and a wireframe; also adopt the W3C spec via the npm library, API, sdk, UI, UI");
    expect(both).toEqual([...FEATURE_TRIPLE, "researcher", "ux-designer"]);
  });

  it("matches whole words only and ignores case", () => {
    expect(selectPanel("feature", "a monkey keyed the npmrc", "")).toEqual(FEATURE_TRIPLE);
    expect(selectPanel("feature", "NPM", "")).toContain("researcher");
  });

  it("is bounded on hostile input: a huge unmatched text is scanned in bounded time", () => {
    const t0 = Date.now();
    selectPanel("feature", "x", "a".repeat(5_000_000));
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
