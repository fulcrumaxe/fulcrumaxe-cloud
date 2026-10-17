import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import { PLANE_IDENTITY_EMAIL, PLANE_IDENTITY_NAME, readPlanePushIdentity } from "../src/repos/planePushIdentity.js";
import { MAX_PLANE_TITLE_LENGTH, PLANE_TITLE_LINE, buildPlanePushText } from "../src/repos/planePushText.js";

/**
 * D#598 P1f-2b: the public pull request text and the platform identity. Both are pure and read nothing but their arguments, so they are
 * tested with no database and no environment.
 */

const RUN = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";
const FIXED = "Change from fulcrumaxe run 0f8a4c2e";
const text = (itemTitle: string) => buildPlanePushText({ itemTitle, runId: RUN });

/** The properties C6 acceptance 6 names, checked on every generated title. */
function expectCleanTitle(title: string, label: string): void {
  expect(title, label).not.toMatch(/[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
  expect(title.length, label).toBeGreaterThan(0);
  expect(title.length, label).toBeLessThanOrEqual(MAX_PLANE_TITLE_LENGTH);
  expect(title, label).not.toContain("@");
  expect(title, label).not.toMatch(/#[0-9]/);
  expect(title, label).not.toMatch(/\bgh-[0-9]/i);
  expect(title, label).not.toMatch(/[\p{Default_Ignorable_Code_Point}\u061c]/u);
  expect(title, label).not.toMatch(/[a-z][a-z0-9+.-]*:\/\/|www\./i);
  expect(PLANE_TITLE_LINE.test(title), label).toBe(true);
  expect(title.trim(), label).toBe(title);
}

describe("buildPlanePushText: the title", () => {
  const hostile: Array<[string, string]> = [
    ["a newline", "Add export\nbutton"],
    ["a carriage return", "Add export\rbutton"],
    ["a NUL", "Add\u0000 export"],
    ["10,000 characters", "x".repeat(10_000)],
    ["10,000 words", "word ".repeat(2_000)],
    ["backticks", "Add `rm -rf` button"],
    ["a mention", "Thanks @someone for the fix"],
    ["a URL", "See https://evil.example/path?x=1 for details"],
    ["a www link", "Visit www.evil.example now"],
    ["a closing keyword", "Fixes #12"],
    ["a reference between mentions", "#@12 and #1#2#3"],
    ["only whitespace", " \t \n  "],
    ["only emoji", "\u{1F680}\u{1F680}\u{1F680}"],
    ["empty", ""],
    ["a bidi override", "safe\u202egnp.exe"],
    ["a line separator", "one\u2028two\u2029three"],
    ["a surrogate pair at the cut", `${"a".repeat(99)}\u{1F680}\u{1F680}`],
    ["an at sign joined to a hash", "# @ 5 #5"],
    ["a URL after an underscore", "a_https://evil.example/x"],
    ["a URL after a digit", "1https://evil.example/x"],
    ["a www link after an underscore", "x_www.evil.example"],
    ["a URL glued to a letter", "xhttps://evil.example/x and more"],
    ["a GH reference", "Fixes GH-12 and gh-34"],
    ["a GH reference with mixed case", "gH-7 Gh-8"],
    ["a reference hidden by a zero-width space", "fix #\u200b12 now"],
    ["a mention hidden by a zero-width space", "ping \u200b@octocat"],
    ["a GH reference hidden by a zero-width joiner", "GH-\u200d12"],
    ["a URL scheme split by a zero-width space", "ht\u200btps://evil.example/x"],
    ["only zero-width spaces", "\u200b\u200b\u200b"],
    ["only tag characters", "\u{E0041}\u{E0042}"],
    ["hidden tag text inside a title", "hello\u{E0049}\u{E0047}\u{E004E}\u{E004F}\u{E0052}\u{E0045} world"],
    ["a BOM, marks and an Arabic letter mark", "a\ufeffb\u200ec\u200fd\u061ce"],
  ];

  it.each(hostile)("%s: one line, at most 100 characters, no @, no #<digit>, no URL, valid for the route", (label, title) => {
    expectCleanTitle(text(title).title, label);
  });

  it("is the item title, cleaned, for an ordinary title", () => {
    expect(text("Add the export button").title).toBe("Add the export button");
    expect(text("  Add   the\texport\nbutton  ").title).toBe("Add the export button");
  });

  it("removes a URL wherever it starts, even right after a word character, and keeps the words", () => {
    expect(text("a_https://evil.example/x").title).toBe("a_");
    expect(text("1https://evil.example/x").title).toBe("1");
    expect(text("x_www.evil.example").title).toBe("x_");
    expect(text("see x_www.evil.example now").title).toBe("see x_ now");
  });

  it("removes GH-<digits> references in any case, and only those", () => {
    expect(text("Fixes GH-12 and gh-34 and Gh-5").title).toBe("Fixes and and");
    expect(text("GH-12").title).toBe(FIXED);
    expect(text("ENGH-12 stays").title).toBe("ENGH-12 stays");
    expect(text("gh-abc stays").title).toBe("gh-abc stays");
  });

  it("removes invisible characters: a hidden reference or mention does not survive, and a title of nothing but invisible text gets the fixed title", () => {
    expect(text("fix #\u200b12 now").title).toBe("fix now");
    expect(text("ping \u200b@octocat").title).toBe("ping octocat");
    expect(text("he\u200dllo\u200b world\ufeff").title).toBe("hello world");
    expect(text("a\u200eb\u200fc\u061cd").title).toBe("abcd");
    expect(text("hello\u{E0049}\u{E0047}\u{E004E}\u{E004F}\u{E0052}\u{E0045} world").title).toBe("hello world");
    expect(text("\u200b\u200b\u200b").title).toBe(FIXED);
    expect(text("\u{E0041}\u{E0042}").title).toBe(FIXED);
    expect(text("\u00a0\u3000").title).toBe(FIXED);
  });

  it("removes mentions, issue references and URLs but keeps the words around them", () => {
    expect(text("Fixes #12 @victim https://evil.example/x and more").title).toBe("Fixes victim and more");
    expect(text("Thanks @someone").title).toBe("Thanks someone");
  });

  it("falls back to the fixed run-id title when nothing is left, and never returns null or undefined", () => {
    for (const empty of ["", "   ", "\n\t", "#12", "@", "https://x.example", "#1 #2 #3", "\u0000\u0001"]) expect(text(empty).title, JSON.stringify(empty)).toBe(FIXED);
    // @ts-expect-error a caller that ignores the type still gets a string
    expect(buildPlanePushText({ itemTitle: undefined, runId: RUN }).title).toBe(FIXED);
    // @ts-expect-error a caller that ignores the type still gets a string
    expect(buildPlanePushText({ itemTitle: null, runId: RUN }).title).toBe(FIXED);
    expect(text("\u{1F680}").title).toBe("\u{1F680}");
  });

  it("cuts a long title at 100 characters without splitting a surrogate pair", () => {
    const title = text(`${"a".repeat(99)}\u{1F680}\u{1F680}`).title;
    expect(title).toBe("a".repeat(99));
    expect(text("b".repeat(500)).title).toBe("b".repeat(100));
  });

  it("is deterministic and refuses a run id that is not a lowercase uuid", () => {
    expect(text("Same").title).toBe(text("Same").title);
    for (const bad of ["", "not-a-uuid", RUN.toUpperCase(), `${RUN} `, "../x"]) expect(() => buildPlanePushText({ itemTitle: "t", runId: bad }), bad).toThrow();
  });
});

describe("buildPlanePushText: the body", () => {
  it("is the fixed template with the run id, and the same for every title", () => {
    const a = text("Add the export button").body;
    expect(a).toBe(text("A completely different title").body);
    expect(a).toContain(`Run: ${RUN}`);
    expect(a).not.toMatch(/@|#[0-9]|https?:/);
    expect(a.length).toBeGreaterThan(0);
    expect(a.length).toBeLessThan(2000);
  });

  it("contains no byte of the item title, however hostile", () => {
    for (const title of ["Zebra stripes @zed", "PrivateProjectName", "see https://secret.example/plan", "ünïcöd\u00e9-title"]) {
      const body = text(title).body;
      for (const word of title.split(/[\s@/:]+/).filter((w) => w.length >= 3)) expect(body, word).not.toContain(word);
    }
  });

  it("is one value per run id: only the run id changes it", () => {
    expect(buildPlanePushText({ itemTitle: "x", runId: RUN }).body).not.toBe(buildPlanePushText({ itemTitle: "x", runId: "1f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e" }).body);
  });
});

describe("buildPlanePushText takes the item title and the run id and nothing else", () => {
  it("by type: exactly { itemTitle: string; runId: string }", () => {
    expectTypeOf(buildPlanePushText).parameters.toEqualTypeOf<[{ itemTitle: string; runId: string }]>();
    expectTypeOf(buildPlanePushText).returns.toEqualTypeOf<{ title: string; body: string }>();
    expect(buildPlanePushText.length).toBe(1);
  });

  it("by source: the module imports nothing and reads no environment, clock, file or random source", () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "repos", "planePushText.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bprocess\b|\bDate\b|Math\.random|\brequire\s*\(|\bfetch\s*\(/);
    // Built-output rule: neither module reads a file or a path at run time, so moving the built output changes nothing about them.
    const identity = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "repos", "planePushIdentity.ts"), "utf8");
    for (const module of [source, identity]) expect(module).not.toMatch(/^\s*import\s|\bprocess\b|__dirname|import\.meta|readFileSync|\bfs\b/m);
  });

  it("by use: only the runner token route builds text from it (the push route takes its validity rule, a comment in the protocol names it); nothing on the path an agent output travels does", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".next" || name === ".git" || name.startsWith(".")) continue;
        const full = path.join(dir, name);
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && /planePushText/.test(readFileSync(full, "utf8"))) importers.push(path.relative(root, full));
      }
    };
    for (const top of ["packages", "apps"]) walk(path.join(root, top));
    expect(importers.sort()).toEqual(["packages/pipeline/src/build/planePushRoute.ts", "packages/runner-cloud/src/planePush.ts", "packages/runner-protocol/src/planePush/planePushRoute.ts", "packages/runner-protocol/src/replies.ts"]);
  });
});

describe("readPlanePushIdentity", () => {
  const good = { FX_PLANE_PUSH_IDENTITY_NAME: "Fulcrumaxe Bot", FX_PLANE_PUSH_IDENTITY_EMAIL: "bot@example.com" };

  it("reads both settings as written", () => {
    expect(readPlanePushIdentity(good)).toEqual({ ok: true, identity: { name: "Fulcrumaxe Bot", email: "bot@example.com" } });
  });

  it("reports a missing setting by name, and a blank one as missing", () => {
    expect(readPlanePushIdentity({})).toEqual({ ok: false, problems: [{ setting: "FX_PLANE_PUSH_IDENTITY_NAME", problem: "missing" }, { setting: "FX_PLANE_PUSH_IDENTITY_EMAIL", problem: "missing" }] });
    expect(readPlanePushIdentity({ ...good, FX_PLANE_PUSH_IDENTITY_EMAIL: "   " })).toEqual({ ok: false, problems: [{ setting: "FX_PLANE_PUSH_IDENTITY_EMAIL", problem: "missing" }] });
    expect(readPlanePushIdentity({ ...good, FX_PLANE_PUSH_IDENTITY_NAME: undefined })).toMatchObject({ ok: false });
  });

  it("reports a malformed setting by name and never repeats its value", () => {
    const secret = "pasted-secret value <x>";
    const bad = readPlanePushIdentity({ ...good, FX_PLANE_PUSH_IDENTITY_NAME: secret });
    expect(bad).toEqual({ ok: false, problems: [{ setting: "FX_PLANE_PUSH_IDENTITY_NAME", problem: "malformed" }] });
    expect(JSON.stringify(bad)).not.toContain("pasted");
  });

  it.each([
    ["a name with an angle bracket", { FX_PLANE_PUSH_IDENTITY_NAME: "Bot <b>" }],
    ["a name of 101 characters", { FX_PLANE_PUSH_IDENTITY_NAME: "n".repeat(101) }],
    ["a name with a newline", { FX_PLANE_PUSH_IDENTITY_NAME: "Bot\nTwo" }],
    ["a name with a stray trailing space", { FX_PLANE_PUSH_IDENTITY_NAME: "Bot " }],
    ["an email without a domain", { FX_PLANE_PUSH_IDENTITY_EMAIL: "bot@" }],
    ["an email with a space", { FX_PLANE_PUSH_IDENTITY_EMAIL: "bo t@example.com" }],
    ["an email with a display name", { FX_PLANE_PUSH_IDENTITY_EMAIL: "Bot <bot@example.com>" }],
    ["an email with a trailing newline", { FX_PLANE_PUSH_IDENTITY_EMAIL: "bot@example.com\n" }],
    ["an email with two at signs", { FX_PLANE_PUSH_IDENTITY_EMAIL: "a@b@example.com" }],
  ])("%s is malformed", (_label, over) => {
    expect(readPlanePushIdentity({ ...good, ...over })).toMatchObject({ ok: false });
  });

  it("a value it accepts matches the patterns the run-end route applies, which are these same two", () => {
    const read = readPlanePushIdentity(good);
    if (!read.ok) throw new Error("expected ok");
    expect(PLANE_IDENTITY_NAME.test(read.identity.name)).toBe(true);
    expect(PLANE_IDENTITY_EMAIL.test(read.identity.email)).toBe(true);
    const route = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "pipeline", "src", "build", "planePushRoute.ts"), "utf8");
    expect(route).toContain("const IDENTITY = PLANE_IDENTITY_NAME;");
    expect(route).toContain("const EMAIL = PLANE_IDENTITY_EMAIL;");
    expect(route).toContain("const GIT_SAFE_LINE = PLANE_TITLE_LINE;");
  });
});
