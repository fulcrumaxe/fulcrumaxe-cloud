import { describe, expect, it } from "vitest";
import { TWIN_SYNC_MAX_LISTED, buildTwinSyncText } from "../src/twinSync.js";

/** D#845 ON-27d3: the sync pull request's text. Public facts only; a path that could change how the list reads is counted, not listed. */
describe("buildTwinSyncText", () => {
  const text = (paths: string[]) => buildTwinSyncText({ publicRepo: "acme/widgets", paths, authors: [] });

  it("lists plain paths in a code fence with their count, and says nothing of what it did not list when everything is listed", () => {
    const { title, body } = text(["src/a.ts", "docs/\u00e9t\u00e9.md"]);
    expect(title).toContain("acme/widgets");
    expect(body).toContain("Files: 2");
    expect(body).toContain("```\nsrc/a.ts\ndocs/\u00e9t\u00e9.md\n```");
    expect(body).not.toContain("not listed here");
  });

  it("counts, and does not list, a path with a backtick, a control or line-separator character, a bidirectional control or a zero-width character", () => {
    const unsafe = [
      "a`b.ts",
      "tab\tname.ts",
      "line\u2028sep.ts",
      "para\u2029sep.ts",
      "bidi\u202eexe.ts",
      "bidi\u202aembed.ts",
      "isolate\u2066x.ts",
      "isolate\u2069x.ts",
      "mark\u200fname.ts",
      "mark\u200ename.ts",
      "arabic\u061cmark.ts",
      "zero\u200bwidth.ts",
      "joiner\u200dname.ts",
      "word\u2060joiner.ts",
      "bom\ufeffname.ts",
      "soft\u00adhyphen.ts",
      "mongolian\u180evowel.ts",
    ];
    const { body } = text(["src/safe.ts", ...unsafe]);
    expect(body).toContain("Files: 18");
    expect(body).toContain("```\nsrc/safe.ts\n```");
    expect(body).toContain(`and ${unsafe.length} more not listed here`);
    for (const p of unsafe) expect(body, JSON.stringify(p)).not.toContain(p);
  });

  it("lists at most the cap and counts the rest", () => {
    const { body } = text(Array.from({ length: TWIN_SYNC_MAX_LISTED + 5 }, (_, i) => `src/f${i}.ts`));
    expect(body).toContain(`and 5 more not listed here`);
  });
});
