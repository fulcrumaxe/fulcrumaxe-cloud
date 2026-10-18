import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contextSpillPath, contextSpillWrites, isContextSpill, trimmedMarker } from "@fx/runner";
import { assembleExecutorPrompt } from "../../src/advance/build.js";
import { assembleFixPrompt, assembleReviewPrompt, type FixPromptInput } from "../../src/review/reviewPrompts.js";
import { assemblePrompt, renderMemorySlot, MEMORY_MARKER_ROOM, type MemoryEntry, type PromptParts } from "../../src/prompt/assemblePrompt.js";
import { ROLE_CONTEXT_DEFAULTS, effectiveContextBudget } from "../../src/prompt/contextBudget.js";
import { MAX_FINDING_CHARS, readVerdict } from "../../src/review/verdicts.js";

/** D#600 CX-4a: the cut order, the marker, the spill, trimmed_bytes and trimmed_reason, the pinned input, and the role defaults. */
const HEAD = "a".repeat(40);
const SPEC = "Acceptance: the footer shows the year.";
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
const entry = (over: Partial<MemoryEntry> & { text: string }): MemoryEntry => ({ id: "mem-1", version: 1, name: "House style", origin: "person", ...over });
const section = (r: { sections: ReadonlyArray<{ code: string }> }, code: string) => r.sections.find((s) => s.code === code) as { code: string; bytes: number; trimmed_bytes: number; trimmed_reason?: string } | undefined;
const file = (r: { spill?: { files: Array<{ code: string; text: string }> } }, code: string): string | undefined => r.spill?.files.find((f) => f.code === code)?.text;

const NOTE = "N".repeat(3000);
const ITEM = "I".repeat(2000);
const STABLE = "S".repeat(2500);
const MAP = Array.from({ length: 150 }, (_, i) => `src/dir${i}/file${i}.ts`).join("\n");
const parts = (over: Partial<PromptParts> = {}): PromptParts => ({
  roleLine: "ROLE",
  boundary: "BOUNDARY",
  map: { version: "v1", text: MAP },
  memoryStable: renderMemorySlot([entry({ text: STABLE })], 8192),
  spec: { version: 3, body: SPEC },
  memoryItem: renderMemorySlot([entry({ id: "mem-2", name: "Item", text: ITEM })], 8192),
  notes: [{ code: "note", text: NOTE }],
  output: "OUTPUT",
  ...over,
});
const FULL = assemblePrompt(parts());
const FULL_BYTES = bytes(FULL.prompt);

describe("over budget (acceptance 1)", () => {
  it("cuts the notes first: the full text is in the spill file, the marker is in the prompt, trimmed_bytes > 0 and the reason is over_budget", () => {
    const r = assemblePrompt(parts(), { spill: true, budgetBytes: FULL_BYTES - 100 });
    expect(r.prompt).toContain(trimmedMarker("note"));
    expect(r.prompt).not.toContain(NOTE);
    expect(file(r, "note")).toContain(NOTE);
    expect(section(r, "note")).toMatchObject({ trimmed_reason: "over_budget" });
    expect(section(r, "note")!.trimmed_bytes).toBeGreaterThan(3000);
    // Nothing later in the order was touched.
    for (const code of ["memory_item", "map", "memory_stable"]) expect(section(r, code)!.trimmed_bytes).toBe(0);
    expect(bytes(r.prompt)).toBeLessThanOrEqual(FULL_BYTES - 100);
  });

  it("cuts in the order notes, memory.item, map, memory.stable, and stops as soon as the prompt fits", () => {
    const sizes = (r: ReturnType<typeof assemblePrompt>): string[] => r.sections.filter((s) => s.trimmed_bytes > 0).map((s) => s.code).sort();
    const noteGone = bytes(FULL.prompt) - bytes(NOTE);
    expect(sizes(assemblePrompt(parts(), { spill: true, budgetBytes: noteGone }))).toEqual(["note"]);
    expect(sizes(assemblePrompt(parts(), { spill: true, budgetBytes: noteGone - 500 }))).toEqual(["memory_item", "note"]);
    expect(sizes(assemblePrompt(parts(), { spill: true, budgetBytes: noteGone - 2500 }))).toEqual(["map", "memory_item", "note"]);
    expect(sizes(assemblePrompt(parts(), { spill: true, budgetBytes: 10 }))).toEqual(["map", "memory_item", "memory_stable", "note"]);
  });

  it("the Spec section, the role text, the output block and a pinned file are present in full at any budget, including one below the Spec's size", () => {
    const big = "X".repeat(6000);
    const r = assemblePrompt(parts({ spec: { version: 3, body: big }, pinned: [{ label: "PINNED src/keep.ts", text: "keep me whole" }] }), { spill: true, budgetBytes: 1 });
    expect(r.prompt).toContain(big);
    expect(r.prompt).toContain("keep me whole");
    expect(r.prompt).toContain("ROLE");
    expect(r.prompt).toContain("OUTPUT");
    expect(section(r, "spec")!.trimmed_bytes).toBe(0);
    expect(section(r, "pinned")!.trimmed_bytes).toBe(0);
    expect(r.spill!.files.map((f) => f.code).sort()).toEqual(["map", "memory_item", "memory_stable", "note"]);
    expect(r.spill!.files.some((f) => f.text.includes(big) || f.text.includes("keep me whole"))).toBe(false);
  });

  it("a pinned input sits after the Spec and before this item's memory, under the closed code 'pinned'", () => {
    const r = assemblePrompt(parts({ pinned: [{ label: "PINNED a.ts", text: "aa" }] }));
    expect(r.sections.map((s) => s.code)).toEqual(["boundary", "map", "memory_stable", "spec", "pinned", "memory_item", "note", "output"]);
  });

  it("the uncut fallback holds every cut text, no marker, trimmed_bytes 0", () => {
    const r = assemblePrompt(parts(), { spill: true, budgetBytes: 10 });
    expect(r.spill!.uncut.prompt).toBe(FULL.prompt);
    expect(r.spill!.uncut.prompt).not.toContain("[trimmed:");
    expect(r.spill!.uncut.sections.every((s) => s.trimmed_bytes === 0)).toBe(true);
    expect(isContextSpill(r.spill)).toBe(true);
  });

  it("without a spill file to point at, nothing is cut for the budget and no marker is written", () => {
    const r = assemblePrompt(parts(), { budgetBytes: 10 });
    expect(r.prompt).toBe(FULL.prompt);
    expect(r.prompt).not.toContain("[trimmed:");
    expect(r.spill).toBeUndefined();
  });

  it("a prompt within its budget is not cut and has no spill", () => {
    const r = assemblePrompt(parts(), { spill: true, budgetBytes: FULL_BYTES });
    expect(r.prompt).toBe(FULL.prompt);
    expect(r.spill).toBeUndefined();
  });

  it("a file that would pass the total cap is not cut, and a fallback over the prompt cap cuts nothing", () => {
    const huge = "M".repeat(300_000);
    const r = assemblePrompt(parts({ map: { version: "v1", text: huge } }), { spill: true, budgetBytes: 10 });
    expect(r.prompt).toContain(huge.slice(0, 1000));
    expect(r.sections.find((s) => s.code === "map")!.trimmed_bytes).toBe(0);
    const near = assemblePrompt(parts({ map: { version: "v1", text: "M".repeat(130_000) } }), { spill: true, budgetBytes: 10 });
    expect(near.spill).toBeUndefined();
    expect(near.prompt).not.toContain("[trimmed:");
  });
});

describe("corrections are never cut (TL ruling)", () => {
  const CORRECTION = "C".repeat(4000);
  it("at a tiny budget a correction stays in full, has no marker, is in no spill file and is not trimmed", () => {
    const withCorrection = parts({ notes: [{ code: "note", text: NOTE }, { code: "corrections", text: CORRECTION }] });
    const r = assemblePrompt(withCorrection, { spill: true, budgetBytes: 10 });
    expect(r.prompt).toContain(CORRECTION);
    expect(r.prompt).not.toContain(trimmedMarker("corrections"));
    expect(file(r, "corrections")).toBeUndefined();
    expect((r.spill?.files ?? []).some((f) => f.text.includes(CORRECTION))).toBe(false);
    expect(section(r, "corrections")).toMatchObject({ trimmed_bytes: 0 });
    expect("trimmed_reason" in section(r, "corrections")!).toBe(false);
    // The notes beside it were cut as before.
    expect(section(r, "note")!.trimmed_bytes).toBeGreaterThan(0);
  });
});

describe("the uncut fallback keeps the memory slot capped (TL ruling)", () => {
  const nine = renderMemorySlot([entry({ text: "m".repeat(9 * 1024) })], 8192);
  it("a failed spill write sends the slot at its cap, no marker, the reason recorded", () => {
    const r = assemblePrompt(parts({ memoryStable: nine }), { spill: true, budgetBytes: 10 });
    const uncut = r.spill!.uncut;
    expect(uncut.prompt).toContain(nine.text);
    expect(uncut.prompt).not.toContain(nine.full!);
    expect(uncut.prompt).not.toContain("[trimmed:");
    const sec = uncut.sections.find((s) => s.code === "memory_stable") as { trimmed_bytes: number; trimmed_reason?: string };
    expect(sec).toMatchObject({ trimmed_bytes: nine.trimmedBytes, trimmed_reason: "memory_slot" });
  });
});

describe("the memory slot cut (acceptance 4)", () => {
  const nine = renderMemorySlot([entry({ text: "m".repeat(9 * 1024) })], 8192);

  it("records memory_slot, marks the slot and spills what the slot dropped", () => {
    const r = assemblePrompt(parts({ memoryStable: nine }), { spill: true });
    expect(section(r, "memory_stable")).toMatchObject({ trimmed_reason: "memory_slot" });
    // The marker is inside the slot's cap: the slot is cut again to leave room for it, so it loses a little more than the unmarked cut did.
    const slot = section(r, "memory_stable")!;
    expect(slot.bytes).toBeLessThanOrEqual(8192);
    expect(slot.trimmed_bytes).toBeGreaterThan(nine.trimmedBytes);
    expect(slot.trimmed_bytes).toBeLessThanOrEqual(nine.trimmedBytes + MEMORY_MARKER_ROOM);
    expect(r.prompt).toContain(trimmedMarker("memory_stable"));
    expect(file(r, "memory_stable")!.length).toBeGreaterThan(9 * 1024);
  });

  it("without a spill it records the reason and writes no marker", () => {
    const r = assemblePrompt(parts({ memoryStable: nine }));
    expect(section(r, "memory_stable")).toMatchObject({ trimmed_reason: "memory_slot" });
    expect(r.prompt).not.toContain("[trimmed:");
  });

  it("a section that was not cut has no trimmed_reason key at all", () => {
    expect(FULL.sections.some((s) => "trimmed_reason" in s)).toBe(false);
  });
});

describe("the findings caps (acceptance 5)", () => {
  const long = "F".repeat(2000);
  const verdictFindings = readVerdict("succeeded", { verdict: "needs-fix", findings: [long, "short"], summary: "s" });
  const fix = (over: Partial<FixPromptInput> = {}): FixPromptInput => ({
    owner: "acme", name: "widgets", issue: 7, pr: 41, headSha: HEAD, version: 3, spec: SPEC,
    findings: [{ role: "code-reviewer", verdict: "needs-fix", findings: verdictFindings.findings, fullFindings: verdictFindings.fullFindings, summary: "s" }],
    ...over,
  });

  it("readVerdict keeps the cut text and returns the full text beside it", () => {
    expect(verdictFindings.findings[0]).toHaveLength(MAX_FINDING_CHARS);
    expect(verdictFindings.fullFindings[0]).toHaveLength(2000);
  });

  it("a finding cut at 600 characters carries the marker, the full text is in the findings file, and the reason is findings_cap", () => {
    const r = assembleFixPrompt(fix(), { spill: true });
    expect(r.prompt).toContain(trimmedMarker("findings"));
    expect(r.prompt).not.toContain(long);
    expect(file(r, "findings")).toContain(long);
    expect(section(r, "findings")).toMatchObject({ trimmed_reason: "findings_cap" });
    expect(section(r, "findings")!.trimmed_bytes).toBe(2000 - MAX_FINDING_CHARS);
  });

  it("with no spill (a runner round) the cut stays as it was: no marker, and the reason is still recorded", () => {
    const r = assembleFixPrompt(fix());
    expect(r.prompt).not.toContain("[trimmed:");
    expect(r.spill).toBeUndefined();
    expect(section(r, "findings")).toMatchObject({ trimmed_reason: "findings_cap" });
  });

  it("findings within the caps are neither marked nor spilled, and the budget never cuts them", () => {
    const ok = assembleFixPrompt(fix({ findings: [{ role: "code-reviewer", verdict: "needs-fix", findings: ["a"], summary: "" }] }), { spill: true, budgetBytes: 1 });
    expect(ok.spill).toBeUndefined();
    expect(section(ok, "findings")!.trimmed_bytes).toBe(0);
  });

  it("the review prompt for every role still builds with spill on, and the uncut fallback of the fix prompt has the full finding", () => {
    for (const role of ["code-reviewer", "acceptance-tester", "security-reviewer", "debater"] as const) {
      expect(assembleReviewPrompt({ role, owner: "acme", name: "widgets", issue: 7, pr: 41, headSha: HEAD, baseRef: "main", version: 3, spec: SPEC }, ).prompt).toContain(SPEC);
    }
    expect(assembleFixPrompt(fix(), { spill: true }).spill!.uncut.prompt).toContain(long);
  });
});

describe("spill files are fixed names outside the checkout (acceptance 3)", () => {
  it("a path comes only from a closed code; anything else throws, and a spill with a free-text code or key is refused", () => {
    expect(contextSpillPath("findings")).toBe("/fx/context/findings.md");
    for (const bad of ["../x", "/etc/passwd", "spec", "pinned", "findings/../../x", ""]) expect(() => contextSpillPath(bad as never), bad).toThrow();
    const good = assemblePrompt(parts(), { spill: true, budgetBytes: 10 }).spill!;
    expect(isContextSpill(good)).toBe(true);
    expect(isContextSpill({ ...good, files: [{ code: "../x", text: "t" }] })).toBe(false);
    expect(isContextSpill({ ...good, files: [{ code: "note", text: "t", path: "/etc" }] })).toBe(false);
    expect(isContextSpill({ ...good, files: [{ code: "note", text: "t" }, { code: "note", text: "u" }] })).toBe(false);
    expect(isContextSpill({ ...good, extra: 1 })).toBe(false);
    expect(isContextSpill({ ...good, files: [{ code: "note", text: "x".repeat(262_145) }] })).toBe(false);
    expect(contextSpillWrites(good).every((w) => /^\/fx\/context\/(findings|note|corrections|memory_item|map|memory_stable)\.md$/.test(w.path) && w.mode === 0o444)).toBe(true);
  });

  it("git status in a real workspace is clean after the files are written to the spill directory next to it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cx4a-ws-"));
    try {
      const work = path.join(root, "work");
      const ctx = path.join(root, "fx", "context");
      mkdirSync(work, { recursive: true });
      mkdirSync(ctx, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: work });
      writeFileSync(path.join(work, "a.txt"), "a");
      execFileSync("git", ["add", "a.txt"], { cwd: work });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", "init"], { cwd: work });
      const r = assemblePrompt(parts(), { spill: true, budgetBytes: 10 });
      for (const w of contextSpillWrites(r.spill!)) {
        expect(w.path.startsWith(work)).toBe(false);
        writeFileSync(path.join(ctx, path.basename(w.path)), w.content);
      }
      expect(readFileSync(path.join(ctx, "note.md"), "utf8")).toContain(NOTE);
      expect(execFileSync("git", ["status", "--porcelain"], { cwd: work, encoding: "utf8" })).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the builders with a budget", () => {
  it("an executor build over its budget spills its map, and a runner build never does", () => {
    const input = { owner: "acme", name: "widgets", number: 7, version: 3, spec: SPEC, map: { version: "v1", text: MAP }, runNotes: NOTE };
    const cut = assembleExecutorPrompt(input, { spill: true, budgetBytes: 4096 });
    expect(cut.prompt).toContain(trimmedMarker("map"));
    expect(file(cut, "map")).toContain("src/dir7/file7.ts");
    expect(assembleExecutorPrompt({ ...input, runtime: "runner" }).spill).toBeUndefined();
  });
});

describe("ROLE_CONTEXT_DEFAULTS (acceptance 6; provisional until CX-10 measures 30 runs/role)", () => {
  const KIB = 1024;
  const up = (n: number): number => Math.ceil(n / KIB) * KIB;
  const fixed = (prompt: string, specBytes: number): number => up(bytes(prompt) - specBytes);
  const specOf = (r: ReturnType<typeof assemblePrompt>): number => section(r, "spec")!.bytes;
  const SPEC_ALLOWANCE = 16 * KIB;
  const MEMORY = 4096;
  const NOTES = 4096;
  const fixture = {
    executor: assembleExecutorPrompt({ owner: "acme", name: "widgets", number: 7, version: 3, spec: SPEC }),
    fix: assembleFixPrompt({ owner: "acme", name: "widgets", issue: 7, pr: 41, headSha: HEAD, version: 3, spec: SPEC, findings: [{ role: "code-reviewer", verdict: "needs-fix", findings: ["x"], summary: "y" }] }),
    reviewer: (role: "code-reviewer" | "acceptance-tester" | "security-reviewer" | "debater") => assembleReviewPrompt({ role, owner: "acme", name: "widgets", issue: 7, pr: 41, headSha: HEAD, baseRef: "main", version: 3, spec: SPEC }),
  };

  it("each default is the fixture's fixed text rounded up to a KiB, plus a 16 KiB Spec, the memory slot, notes and the role's large part", () => {
    expect(ROLE_CONTEXT_DEFAULTS.executor).toBe(fixed(fixture.executor.prompt, specOf(fixture.executor)) + SPEC_ALLOWANCE + MEMORY + NOTES + 8 * KIB);
    expect(ROLE_CONTEXT_DEFAULTS.fix).toBe(fixed(fixture.fix.prompt, specOf(fixture.fix)) + SPEC_ALLOWANCE + MEMORY + NOTES + 16 * KIB);
    for (const role of ["code-reviewer", "acceptance-tester", "security-reviewer"] as const) {
      const f = fixture.reviewer(role);
      expect(ROLE_CONTEXT_DEFAULTS[role], role).toBe(fixed(f.prompt, specOf(f)) + SPEC_ALLOWANCE + MEMORY + NOTES);
    }
    const d = fixture.reviewer("debater");
    expect(ROLE_CONTEXT_DEFAULTS.debater).toBe(fixed(d.prompt, specOf(d)) + SPEC_ALLOWANCE + MEMORY + NOTES + 8 * KIB);
  });

  it("a stored budget is used instead of the default; NULL (or a value the column would refuse) uses the default", () => {
    expect(effectiveContextBudget("executor", null)).toBe(ROLE_CONTEXT_DEFAULTS.executor);
    expect(effectiveContextBudget("executor", 10_000)).toBe(10_000);
    expect(effectiveContextBudget("fix", 5)).toBe(ROLE_CONTEXT_DEFAULTS.fix);
    expect(effectiveContextBudget("debater", 3_000_000)).toBe(ROLE_CONTEXT_DEFAULTS.debater);
  });
});
