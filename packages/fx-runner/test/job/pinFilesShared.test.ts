import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { excludeCovers, pinLedgerNotes, type PinFileSource } from "@fulcrumaxe/runner-protocol";
import { checkoutPinSource, readJobPins } from "../../src/job/pinFiles.js";

/**
 * D#600 CX-5c2: the runner's half of the shared pin table. The cloud's sandbox path (packages/pipeline/test/prompt/pinCasesShared.test.ts) reads this same fixture and must
 * reach the same files read and the same ledger reasons for the same inputs; this half runs each case on a real directory through the runner's own file source.
 */
type FileSpec = string | { fill: string; count: number } | { bytes: string };
interface Case {
  name: string;
  files: Record<string, FileSpec>;
  pins: string[];
  excludes: string[];
  budget?: number;
  generate?: number;
  read: string[];
  readFirst?: number;
  neverRead?: string[];
  notes: Array<{ reason: string; bytes: number }>;
}
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/pinCasesShared.json");
const CASES = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { cases: Case[] }).cases;

const textOf = (spec: FileSpec): string => (typeof spec === "string" ? spec : "fill" in spec ? spec.fill.repeat(spec.count) : spec.bytes);
export function expandCase(c: Case): { files: Record<string, string>; pins: string[]; read: string[] } {
  const files = Object.fromEntries(Object.entries(c.files).map(([p, spec]) => [p, textOf(spec)]));
  const pins = [...c.pins];
  const generated = Array.from({ length: c.generate ?? 0 }, (_, i) => `f${String(i).padStart(3, "0")}`);
  for (const p of generated) {
    files[p] = p;
    pins.push(p);
  }
  return { files, pins, read: [...c.read, ...generated.slice(0, c.readFirst ?? 0)] };
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function checkout(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "fx-pins-"));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  return root;
}

describe("the shared pin cases, run on the local runner's checkout reader", () => {
  it("the table is not empty and every case names its expectations", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(12);
    for (const c of CASES) expect(c.notes, c.name).toBeDefined();
  });

  for (const c of CASES) {
    it(c.name, async () => {
      const { files, pins, read } = expandCase(c);
      const root = checkout(files);
      const real = checkoutPinSource(root);
      const asked: Array<{ call: "stat" | "text"; path: string }> = [];
      const recording: PinFileSource = {
        stat: (p) => (asked.push({ call: "stat", path: p }), real.stat(p)),
        text: (p, max) => (asked.push({ call: "text", path: p }), real.text(p, max)),
      };
      const out = await readJobPins({ pins: { paths: pins, ...(c.budget === undefined ? {} : { budget_bytes: c.budget }) }, excludes: c.excludes }, root, recording);
      expect(out?.items.map((i) => i.path)).toEqual(read);
      for (const item of out?.items ?? []) expect(item.text).toBe(files[item.path]);
      expect(pinLedgerNotes(out!, out!.budgetBytes).map((n) => ({ reason: n.trimmed_reason, bytes: n.bytes }))).toEqual(c.notes);
      // A file a case says must never be read is never given to the source's text reader; a pin an exclude covers is not even looked up.
      for (const p of c.neverRead ?? []) expect(asked.filter((a) => a.call === "text").map((a) => a.path), p).not.toContain(p);
      for (const p of pins.filter((pin) => c.excludes.some((e) => excludeCovers(e, pin)))) expect(asked.map((a) => a.path), p).not.toContain(p);
    });
  }
});
