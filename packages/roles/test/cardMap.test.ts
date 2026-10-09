import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import cardMap from "../src/cardMap.json" with { type: "json" };
import { loadRoleCard } from "../src/cards.js";
import { ROLE_MANIFEST } from "../src/manifest.js";
// @ts-expect-error the generator is a plain .mjs with no types
import { MAP_PATH, renderCardMap } from "../scripts/generate-card-map.mjs";

const CARD_MAP: Readonly<Record<string, string>> = cardMap;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CARDS_DIR = path.join(ROOT, "cards");
const cardFiles = (): string[] => readdirSync(CARDS_DIR).filter((f) => f.endsWith(".md")).sort();

describe("the generated card map (D#2 H14c-3-3a)", () => {
  it("the committed map is exactly what the generator makes from cards/*.md (drift fails here)", () => {
    expect(readFileSync(MAP_PATH as string, "utf8")).toBe(renderCardMap() as string);
  });

  it("the generator is deterministic and its output tracks a card edit on that card's line only", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fx-cardmap-"));
    try {
      cpSync(CARDS_DIR, dir, { recursive: true });
      const before = (renderCardMap(dir) as string).split("\n");
      expect(renderCardMap(dir)).toBe(before.join("\n"));
      writeFileSync(path.join(dir, "project-manager.md"), "edited\n");
      const after = (renderCardMap(dir) as string).split("\n");
      expect(after.filter((line, i) => line !== before[i])).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds every card file and every manifest role, with the file's own text", () => {
    expect(Object.keys(CARD_MAP)).toEqual(cardFiles().map((f) => f.slice(0, -3)));
    expect(Object.keys(CARD_MAP)).toHaveLength(26);
    for (const { name } of ROLE_MANIFEST) {
      expect(CARD_MAP[name], name).toBe(readFileSync(path.join(CARDS_DIR, `${name}.md`), "utf8"));
      expect(loadRoleCard(name), name).toBe(CARD_MAP[name]);
    }
  });

  it("a name outside the manifest has no card, however the map or the disk is spelled", () => {
    for (const bad of ["", "nope", "../cards/project-manager", "__proto__", "constructor", "toString"]) expect(loadRoleCard(bad), bad).toBeUndefined();
  });

  it("a build that moved away from the cards still loads one: the sources copied to a directory with no cards/ next to them, run as production", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fx-cardmap-moved-"));
    try {
      cpSync(path.join(ROOT, "src"), path.join(dir, "src"), { recursive: true });
      writeFileSync(path.join(dir, "probe.ts"), 'import { loadRoleCard } from "./src/cards.js";\nconst t = loadRoleCard("project-manager");\nconsole.log(typeof t === "string" ? t.length : -1);\n');
      // `node --import tsx`, not the `tsx` CLI: the CLI opens a Unix-socket IPC pipe, which the runner's sandbox refuses (B1).
      // The loader is named by absolute URL because the probe runs in a directory with no node_modules.
      const tsxLoader = pathToFileURL(createRequire(path.join(ROOT, "package.json")).resolve("tsx")).href;
      const out = execFileSync(process.execPath, ["--import", tsxLoader, path.join(dir, "probe.ts")], {
        cwd: dir,
        env: { PATH: process.env.PATH ?? "", NODE_ENV: "production", ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
        encoding: "utf8",
      });
      expect(Number(out.trim())).toBe(CARD_MAP["project-manager"]!.length);
      expect(readdirSync(dir)).not.toContain("cards");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
