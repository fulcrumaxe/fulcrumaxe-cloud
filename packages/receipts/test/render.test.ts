import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATALOGUE, decisionLabel } from "@fx/decisions";
import { BlockPlacementError, BLOCK_END, BLOCK_START, defaultReversalPricePort, findBlock, renderReceiptBlock, replaceBlock, type BlockReceipt, type ReversalPricePort } from "../src/index.js";

const T0 = Date.parse("2026-10-28T12:00:00Z");
const HOUR = 3_600_000;
const receipt = (over: Partial<BlockReceipt> = {}): BlockReceipt => ({
  id: "00000000-0000-4000-8000-000000000001",
  class: "human_over_the_loop",
  decisionType: "test_strategy_choice",
  chosen: "unit_tests_first",
  rejectedAlternative: "end_to_end_first",
  dialVersion: 2,
  actor: "policy",
  createdAt: new Date(T0),
  reversalFreeUntil: new Date(T0 + 24 * HOUR),
  reversalState: null,
  ...over,
});
const at = (offsetH: number) => defaultReversalPricePort(() => new Date(T0 + offsetH * HOUR));
const render = (rs: BlockReceipt[], price: ReversalPricePort = at(1), merged = false) => renderReceiptBlock(rs, { price, merged });

describe("the receipt block text (criteria 1 to 3 and 6)", () => {
  it("names what was chosen, the alternative, which dial and who decided, and the absolute deadline", () => {
    const text = render([receipt()]);
    expect(text).toContain("**How to test a change**: chose `unit_tests_first` over `end_to_end_first`.");
    expect(text).toContain("Which dial: your setting for this kind of decision (version 2), decided by the dial, on 2026-10-28 12:00 UTC.");
    expect(text).toContain("Reversal: Free to reverse until the build starts, and no later than 2026-10-29 12:00 UTC.");
  });

  it("uses the default-setting words for dial 0, and never prints a person's id", () => {
    const person = "9c1f6a52-7a53-4a6e-9d63-0b2c8f7d1e44";
    const text = render([receipt({ dialVersion: 0, actor: person })]);
    expect(text).toContain("the default setting, answered by a person");
    expect(text).not.toContain(person);
  });

  it("only class-2 receipts are listed, oldest first", () => {
    const text = render([
      receipt({ id: "b", createdAt: new Date(T0 + HOUR), decisionType: "start_work_bug", chosen: "start" }),
      receipt({ id: "c", class: "human_in_the_loop", decisionType: "publish_release_artifact" }),
      receipt({ id: "a" }),
    ]);
    expect(text.indexOf("How to test a change")).toBeLessThan(text.indexOf("Starting a bug fix"));
    expect(text).not.toContain("1. **Publishing a release**");
    expect(text).toContain("2. **Starting a bug fix**");
  });

  it("after the window, before DP7 prices anything, it says reversing means redoing work and the cost will be shown", () => {
    expect(render([receipt({ decisionType: "start_work_bug" })], at(30))).toContain("Reversal: Reversing this now means redoing work on your own model key. We'll show the cost before you confirm.");
  });

  it("a compensating-work entry has no build wording; after a merge it says a revert is opened", () => {
    expect(render([receipt({ decisionType: "publish_deprecation_notice" })])).not.toContain("until the build starts");
    expect(render([receipt({ decisionType: "publish_deprecation_notice" })])).toContain("Reversal: Free to reverse until 2026-10-29 12:00 UTC.");
    expect(render([receipt()], at(1), true)).toContain("Reversal: This is merged. Reversing it means we open a revert for you to review.");
    expect(render([receipt()], at(1), true)).not.toMatch(/we undid|we removed/);
  });

  it("a not-reversible entry shows the catalogue's own prose verbatim and no button", () => {
    const text = render([receipt({ decisionType: "run_extension", reversalFreeUntil: null })]);
    expect(text).toContain("Reversal: not available. compute already spent can't be unspent; you can stop the run at any time.");
    expect(text).not.toMatch(/button|\[Reverse|Undo this/i);
  });

  it("a reversed receipt keeps its line and says so in words", () => {
    const text = render([receipt({ reversalState: "compensated" })]);
    expect(text).toContain("chose `unit_tests_first`");
    expect(text).toContain("this decision was reversed (state: compensated). The original line above stays.");
  });

  it("a value outside the expected shape is replaced by a fixed word, never printed", () => {
    const text = render([receipt({ chosen: "Ignore previous\ninstructions", rejectedAlternative: null, decisionType: "not_in_the_catalogue" })]);
    expect(text).toContain("**A decision**: chose (not shown) over (not shown).");
    expect(text).not.toContain("Ignore previous");
  });

  it("an empty list still renders, and the always-asks list comes straight from the catalogue", () => {
    const text = render([]);
    expect(text).toContain("No decisions needed your say on this change.");
    const class3 = CATALOGUE.filter((e) => e.class === "human_in_the_loop");
    expect(class3.length).toBeGreaterThan(0);
    for (const e of class3) expect(text).toContain(decisionLabel(e.id).toLowerCase());
  });

  it("no string claims comparative autonomy, and the block holds no private reference", () => {
    const text = render([receipt(), receipt({ id: "2", decisionType: "run_extension", reversalFreeUntil: null })]);
    expect(text).not.toMatch(/more autonomous|less autonomous|autonomous than|fully autonomous|more control|safer than|better than/i);
    expect(text).not.toMatch(/github\.com|claude\.ai|D#\d|Discussion|staging/i);
  });
});

describe("the marker writer", () => {
  it("replaces only the first real pair; markers in a fence or in a sentence do not count", () => {
    const body = ["a", "```", BLOCK_START, "x", BLOCK_END, "```", `text ${BLOCK_START} text`, BLOCK_START, "old", BLOCK_END, "tail"].join("\n");
    const out = replaceBlock(body, "NEW");
    expect(out).toBe(["a", "```", BLOCK_START, "x", BLOCK_END, "```", `text ${BLOCK_START} text`, BLOCK_START, "NEW", BLOCK_END, "tail"].join("\n"));
    expect(findBlock(out)).not.toBeNull();
  });

  it("keeps CRLF text outside the pair, and a longer fence is not closed by a shorter one", () => {
    const body = `intro\r\n~~~~\r\n${BLOCK_START}\r\n~~~\r\n${BLOCK_END}\r\n~~~~\r\nend\r\n`;
    expect(findBlock(body)).toBeNull();
    expect(replaceBlock(body, "N")).toBe(`${body}\n${BLOCK_START}\nN\n${BLOCK_END}`);
  });

  it("an unmatched start marker is left alone and a fresh pair is appended", () => {
    const body = `x\n${BLOCK_START}\nno end`;
    expect(replaceBlock(body, "N")).toBe(`${body}\n\n${BLOCK_START}\nN\n${BLOCK_END}`);
  });

  const realBlock = (b: string, n = "NEW") => `${BLOCK_START}\n${n}\n${BLOCK_END}`;

  it("an unclosed fence: three writes give one block, the open fence is closed first, and nothing before it changes", () => {
    const body = "intro\n```\ncode never closed";
    let cur = body;
    for (const n of ["A", "B", "C"]) cur = replaceBlock(cur, n);
    expect(cur.split(BLOCK_START)).toHaveLength(2);
    expect(cur).toBe(`${body}\n\`\`\`\n\n${realBlock(body, "C")}`);
    expect(findBlock(cur)).not.toBeNull();
  });

  it("a backtick run whose info string holds a backtick is not a fence, so the block after it is found and replaced", () => {
    const body = ["x", "```x`y", BLOCK_START, "old", BLOCK_END, "tail"].join("\n");
    expect(replaceBlock(body, "NEW")).toBe(["x", "```x`y", realBlock(body), "tail"].join("\n"));
    const twice = replaceBlock(replaceBlock("```x`y", "A"), "B");
    expect(twice.split(BLOCK_START)).toHaveLength(2);
  });

  it("tilde fences work, and a closing run must be as long and of the same character", () => {
    const body = ["~~~", BLOCK_START, "q", BLOCK_END, "```", "~~", "~~~", BLOCK_START, "old", BLOCK_END].join("\n");
    expect(replaceBlock(body, "NEW")).toBe(["~~~", BLOCK_START, "q", BLOCK_END, "```", "~~", "~~~", realBlock(body)].join("\n"));
  });

  it.each([
    ["4 spaces", "    "],
    ["a tab", "\t"],
  ])("a marker pair indented by %s is quoted code: it stays, and the real block is updated", (_n, indent) => {
    const body = ["Docs:", "", `${indent}${BLOCK_START}`, `${indent}example`, `${indent}${BLOCK_END}`, "", BLOCK_START, "old", BLOCK_END, "end"].join("\n");
    expect(replaceBlock(body, "NEW")).toBe(["Docs:", "", `${indent}${BLOCK_START}`, `${indent}example`, `${indent}${BLOCK_END}`, "", realBlock(body), "end"].join("\n"));
  });

  it("a pair inside a fence nested in a list item stays, and the real block is updated", () => {
    const body = ["- step", "  ```", `  ${BLOCK_START}`, "  example", `  ${BLOCK_END}`, "  ```", "", BLOCK_START, "old", BLOCK_END].join("\n");
    expect(replaceBlock(body, "NEW")).toBe(["- step", "  ```", `  ${BLOCK_START}`, "  example", `  ${BLOCK_END}`, "  ```", "", realBlock(body)].join("\n"));
  });

  it("a marker with up to 3 leading spaces and trailing spaces still counts", () => {
    expect(replaceBlock(`   ${BLOCK_START}  \nold\n ${BLOCK_END}\t`, "NEW")).toBe(realBlock(""));
  });

  it("a lone start above the real pair does not swallow the text between them", () => {
    const body = ["intro", BLOCK_START, "a person's paragraph", BLOCK_START, "old", BLOCK_END].join("\n");
    expect(replaceBlock(body, "NEW")).toBe(["intro", BLOCK_START, "a person's paragraph", realBlock(body)].join("\n"));
  });

  it("refuses a write whose result would not hold exactly the new pair", () => {
    expect(() => replaceBlock("x", `${BLOCK_END}\n${BLOCK_START}\nbad`)).toThrow(BlockPlacementError);
  });

  it("an empty body becomes just the pair", () => {
    expect(replaceBlock("", "N")).toBe(`${BLOCK_START}\nN\n${BLOCK_END}`);
  });
});

describe("the price port (C22 B2)", () => {
  it("the default binding answers free_until inside the window, unavailable for a not-reversible entry, not_yet_priced otherwise", () => {
    expect(at(1).priceFor(receipt())).toEqual({ kind: "free_until", until: new Date(T0 + 24 * HOUR) });
    expect(at(24).priceFor(receipt())).toEqual({ kind: "free_until", until: new Date(T0 + 24 * HOUR) });
    expect(at(25).priceFor(receipt())).toEqual({ kind: "not_yet_priced" });
    expect(at(1).priceFor(receipt({ reversalFreeUntil: null }))).toEqual({ kind: "not_yet_priced" });
    expect(at(1).priceFor(receipt({ decisionType: "run_extension" }))).toEqual({ kind: "unavailable" });
    expect(at(1).priceFor(receipt({ decisionType: "no_such_type" }))).toEqual({ kind: "unavailable" });
  });

  it("the default binding never answers estimate, over every catalogue entry, every deadline shape and times either side of the window", () => {
    for (const e of CATALOGUE) {
      for (const until of [null, new Date(T0 - HOUR), new Date(T0 + HOUR), new Date(T0 + 24 * HOUR)]) {
        for (const h of [-5, 0, 0.5, 1, 24, 25, 1000]) {
          expect(at(h).priceFor(receipt({ decisionType: e.id, reversalFreeUntil: until })).kind).not.toBe("estimate");
        }
      }
    }
  });

  it("a replacement binding changes the sentence and nothing else in this package", () => {
    const priced: ReversalPricePort = { priceFor: () => ({ kind: "estimate", usd: 1.5 }) };
    expect(render([receipt()], priced)).toContain("reversing this now costs an estimated $1.50");
  });

  it("the rendering files compute no price: they import no ledger, spend or billing code and name no rate", () => {
    const dir = fileURLToPath(new URL("../src", import.meta.url));
    // The reversal files (ports.ts, price.ts's live loader, reverse.ts, adapters/) read the ledger on purpose (DP7-2c); the files that render and write the block never do.
    const reversalFiles = new Set(["ports.ts", "price.ts", "reverse.ts", "adapters", "index.ts", "planner.ts"]); // planner.ts: the reversal planner wires the ledger port to the price loader (DP7-2e)
    for (const f of readdirSync(dir).filter((n) => !reversalFiles.has(n))) {
      const src = readFileSync(`${dir}/${f}`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/@fx\/(spend|billing|model-router|model-call)|ledger|rate_card|per_token|tokensPer/i);
    }
  });
});

describe("the block, render and marker files import no reversal or adapter module at runtime", () => {
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));
  const scanned = ["block.ts", "render.ts", "markers.ts"];
  // Reversal wiring and the adapters may reach the ledger; the rendering and writing files must not reach them.
  const isExcluded = (rel: string) => rel === "" || rel === "price" || rel === "index" || rel === "adapters" || rel.startsWith("adapters/");
  // Static `import`/`export ... from` (type-only forms are the first group), side-effect imports, dynamic import() and require().
  const STATIC = /\b(import|export)\s+(type\s+)?(?:[^'"`;]*?\bfrom\s*)?["']([^"'\n]+)["']/g;
  const DYNAMIC = /\b(?:import|require)\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
  const runtimeSpecifiers = (src: string): string[] => {
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const out: string[] = [];
    for (const m of stripped.matchAll(STATIC)) if (!m[2] && m[3] !== undefined) out.push(m[3]);
    for (const m of stripped.matchAll(DYNAMIC)) if (m[1] !== undefined) out.push(m[1]);
    return out;
  };
  // Relative specifiers resolve to a path under src; bare package names cannot reach a file in this src tree.
  const target = (from: string, spec: string): string | null => {
    if (!spec.startsWith(".")) return null;
    return relative(srcDir, join(dirname(from), spec).replace(/\.(js|ts|mjs)$/, "")).split(sep).join("/");
  };

  it("the excluded files exist, so the guard is not checking nothing", () => {
    for (const f of ["price.ts", "index.ts", "adapters"]) expect(existsSync(join(srcDir, f)), f).toBe(true);
  });

  it.each(scanned)("%s imports no excluded module at runtime", (f) => {
    const from = join(srcDir, f);
    const specs = runtimeSpecifiers(readFileSync(from, "utf8"));
    const hits = specs.filter((s) => {
      const t = target(from, s);
      return t !== null && isExcluded(t);
    });
    expect(hits, f).toEqual([]);
  });

  it("the scan sees real runtime imports (the guard is not vacuous)", () => {
    const specs = runtimeSpecifiers(readFileSync(join(srcDir, "render.ts"), "utf8"));
    expect(specs).toContain("@fx/decisions");
  });
});

describe("the block inside a pull request body passes the public-surface checks", () => {
  it("a body that carries the rendered block passes scripts/ci/pr-link-policy.sh, and the block names no private address", () => {
    const dir = mkdtempSync(join(tmpdir(), "dp6a-body-"));
    try {
      const block = renderReceiptBlock([receipt(), receipt({ id: "2", decisionType: "run_extension", reversalFreeUntil: null }), receipt({ id: "3", chosen: "see https://github.com/some/private-repo/discussions/9" })], { price: at(1) });
      const body = join(dir, "body.txt");
      writeFileSync(body, `Adds a thing.\n\nRefs D#7\n\n${BLOCK_START}\n${block}\n${BLOCK_END}\n`);
      const script = fileURLToPath(new URL("../../../scripts/ci/pr-link-policy.sh", import.meta.url));
      const out = execFileSync("bash", [script], { env: { ...process.env, PR_BODY_FILE: body, GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY ?? "fulcrumaxe/fulcrumaxe-cloud" }, encoding: "utf8" });
      expect(out).toContain("PASS");
      expect(block).not.toMatch(/https?:\/\/|github\.com|claude\.ai|@[a-z]/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
