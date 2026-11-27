import { describe, expect, it } from "vitest";
import { TWIN_FIXED_PRIVATE, TWIN_PUBLISH_FOOTER, TWIN_PUBLISH_MAX_LISTED, buildTwinPublishText } from "../src/twinPublish.js";
import { PLANE_TITLE_LINE } from "../src/planePush/planePushText.js";
import { scanText } from "../src/planePush/planePush.js";

/** D#845 ON-27c2: the fixed template of a publish pull request. Nothing but a count, a date and the published paths is an input. */
describe("twin publish text", () => {
  it("is the fixed template: a title with the count and the date, the file count, the paths in a fence, the footer", () => {
    const text = buildTwinPublishText({ commits: 3, date: "2026-11-26", paths: ["src/a.ts", "docs/guide.md"] });
    expect(text.title).toBe("Publish 3 merged changes from fulcrumaxe (2026-11-26)");
    expect(text.body).toBe(`Files: 2\n\n\`\`\`\nsrc/a.ts\ndocs/guide.md\n\`\`\`\n\n${TWIN_PUBLISH_FOOTER}`);
    expect(buildTwinPublishText({ commits: 1, date: "2026-11-26", paths: ["a"] }).title).toBe("Publish 1 merged change from fulcrumaxe (2026-11-26)");
    expect(PLANE_TITLE_LINE.test(text.title)).toBe(true);
  });

  it("carries no private pull request title, Discussion number, repository name or twin name: the same inputs give the same text whatever the private side says", () => {
    // The function has no parameter a private title, number or name could arrive through; this pins that the only things in the output are the template and the paths.
    const privateWords = ["Fix the billing leak for acme-corp", "D#845", "widgets-private", "twin"];
    const text = buildTwinPublishText({ commits: 2, date: "2026-11-26", paths: ["src/index.ts"] });
    for (const word of privateWords) expect(`${text.title}\n${text.body}`.toLowerCase(), word).not.toContain(word.toLowerCase());
    // and the route's own text scan finds nothing in it, with the always-on rules
    expect(scanText("pull request title", text.title, {})).toEqual([]);
    expect(scanText("pull request body", text.body, {})).toEqual([]);
  });

  it("keeps a path with a mention, an issue number or a fence out of the places GitHub would act on it", () => {
    const text = buildTwinPublishText({ commits: 1, date: "2026-11-26", paths: ["docs/@octocat.md", "notes/#12.md", "weird`name.md", "line\nbreak.md"] });
    // the unsafe two are counted but not listed; the other two sit inside the fence
    expect(text.body).toContain("Files: 4");
    expect(text.body).toContain("```\ndocs/@octocat.md\nnotes/#12.md\n```");
    expect(text.body).not.toContain("weird");
    expect(text.body).toContain("and 2 more not listed here");
  });

  it("lists at most the cap and says how many more there are", () => {
    const paths = Array.from({ length: TWIN_PUBLISH_MAX_LISTED + 5 }, (_, n) => `f${n}.txt`);
    const text = buildTwinPublishText({ commits: 1, date: "2026-11-26", paths });
    expect(text.body).toContain(`Files: ${paths.length}`);
    expect(text.body.split("\n").filter((l) => /^f\d+\.txt$/.test(l))).toHaveLength(TWIN_PUBLISH_MAX_LISTED);
    expect(text.body).toContain("and 5 more not listed here");
  });

  it("refuses a count or a date that is not what the template says", () => {
    for (const commits of [0, -1, 1.5, Number.NaN]) expect(() => buildTwinPublishText({ commits, date: "2026-11-26", paths: [] })).toThrow(TypeError);
    for (const date of ["26-11-2026", "2026-11-26T00:00", "today", ""]) expect(() => buildTwinPublishText({ commits: 1, date, paths: [] })).toThrow(TypeError);
  });

  it("keeps one list of the paths that are private on every twin", () => {
    expect(TWIN_FIXED_PRIVATE).toEqual([".autonomous-team/**", ".claude/**", "CLAUDE.md", "CLAUDE.project.md", "docs/PRD.md", "epics/**", ".env", ".env.*", "**/*.pem", "**/*.key"]);
  });
});
