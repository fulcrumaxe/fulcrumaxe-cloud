import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pinLedgerNotes, splitPinsByExcludes } from "@fulcrumaxe/runner-protocol";
import { createPinContentPort, type PinSource } from "../../src/prompt/pinContent.js";

/**
 * D#600 CX-5c2: the cloud sandbox path's half of the shared pin table. The local runner's test (packages/fx-runner/test/job/pinFilesShared.test.ts) reads this same
 * fixture and runs each case on a real checkout; both must reach the same files read and the same ledger reasons for the same inputs. Here the files come from GitHub's
 * trees and blobs APIs, in the shapes the real ones answer (the blob call refuses a file over the byte cap it is given).
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
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fx-runner/test/fixtures/pinCasesShared.json");
const CASES = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { cases: Case[] }).cases;
const textOf = (spec: FileSpec): string => (typeof spec === "string" ? spec : "fill" in spec ? spec.fill.repeat(spec.count) : spec.bytes);

class Gh implements PinSource {
  blobCalls: string[] = [];
  private readonly bySha = new Map<string, { path: string; text: string }>();
  private readonly entries: Array<{ path: string; type: "blob" | "tree" | "commit"; sha: string; size?: number }> = [];
  constructor(files: Record<string, string>) {
    let n = 0;
    for (const [p, text] of Object.entries(files)) {
      const sha = (n++).toString(16).padStart(40, "0");
      this.entries.push({ path: p, type: "blob", sha, size: Buffer.byteLength(text, "utf8") });
      this.bySha.set(sha, { path: p, text });
      // Every folder on the way is a tree entry, as the real recursive listing has it.
      for (let at = p.lastIndexOf("/"); at > 0; at = p.lastIndexOf("/", at - 1)) {
        const dir = p.slice(0, at);
        if (!this.entries.some((e) => e.path === dir)) this.entries.push({ path: dir, type: "tree", sha: (900 + this.entries.length).toString(16).padStart(40, "0") });
      }
    }
  }
  async headSha() {
    return "a".repeat(40);
  }
  async tree() {
    return { truncated: false, entries: this.entries };
  }
  async blob(sha: string, maxBytes = 65_536) {
    const file = this.bySha.get(sha);
    if (file === undefined) return null;
    this.blobCalls.push(file.path);
    return Buffer.byteLength(file.text, "utf8") > maxBytes ? null : file.text;
  }
}

describe("the shared pin cases, run on the cloud sandbox path (build step: split, read, note)", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const files = Object.fromEntries(Object.entries(c.files).map(([p, spec]) => [p, textOf(spec)]));
      const generated = Array.from({ length: c.generate ?? 0 }, (_, i) => `f${String(i).padStart(3, "0")}`);
      for (const p of generated) files[p] = p;
      const pins = [...c.pins, ...generated];
      const gh = new Gh(files);
      const { readable, excluded } = splitPinsByExcludes(pins, c.excludes);
      const port = createPinContentPort({ open: async () => gh });
      const out = await port.forRun({ accountId: "a", repoId: "r", owner: "o", name: "n", paths: readable });
      expect(out.items.map((i) => i.path)).toEqual([...c.read, ...generated.slice(0, c.readFirst ?? 0)]);
      for (const item of out.items) expect(item.text).toBe(files[item.path]);
      expect(pinLedgerNotes({ ...out, excluded }, c.budget).map((n) => ({ reason: n.trimmed_reason, bytes: n.bytes }))).toEqual(c.notes);
      for (const p of c.neverRead ?? []) expect(gh.blobCalls, p).not.toContain(p);
    });
  }
});
