import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sanitizeCheckpointSummary as cloudSanitize } from "@fx/runner";
import { CHECKPOINT_PATHS_MAX, CHECKPOINT_PROMPT, CHECKPOINT_TEXT_MAX_BYTES, isRepoRelativePath, noteFromEnvelope, sanitizeCheckpointSummary } from "../../src/job/checkpoint.js";

/**
 * The cloud's own checkpoint turn (HO-4) pins this same hash. Changing the prompt is a decision for both sides, so the hash is a literal here:
 * a change that does not update it fails, and the cloud's test fails with it.
 */
const CHECKPOINT_PROMPT_SHA256 = "c4ef0ea4c53d5e916e1e9dae804a808c4ef58a0bd5fa532d1458be84a0b2b495";

describe("the constant checkpoint prompt", () => {
  it("is pinned by hash", () => {
    expect(createHash("sha256").update(CHECKPOINT_PROMPT, "utf8").digest("hex")).toBe(CHECKPOINT_PROMPT_SHA256);
  });

  it("holds nothing of a job: no braces to fill, no template markers, no interpolation", () => {
    expect(CHECKPOINT_PROMPT).not.toMatch(/\$\{|\{\{|%s|<job|<run|<branch/);
    // The one JSON example is the only place with braces, and it uses placeholder words.
    expect(CHECKPOINT_PROMPT.match(/\{/g)).toHaveLength(1);
  });

  it("tells the agent to commit and not to push, and asks for the envelope the runner reads", () => {
    expect(CHECKPOINT_PROMPT).toMatch(/Commit every change/);
    expect(CHECKPOINT_PROMPT).toMatch(/Do not push/);
    expect(CHECKPOINT_PROMPT).toContain("<!-- AGENT_OUTPUT -->");
  });
});

describe("sanitizeCheckpointSummary (the public copy)", () => {
  const samples = ["plain", "a\u0000b\u202ec\u200bd", "é".repeat(3000), "x".repeat(5000), "😀".repeat(1500), "", "\u0007\u0008"];
  it("answers exactly as the cloud's own function does, at the shared cap", () => {
    for (const sample of samples) expect(sanitizeCheckpointSummary(sample), JSON.stringify(sample.slice(0, 12))).toBe(cloudSanitize(sample));
  });
  it("caps on a character boundary at the given number of bytes", () => {
    const cut = sanitizeCheckpointSummary("😀".repeat(500), 1024);
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(1024);
    expect(cut).not.toContain("\ufffd");
    expect(cut.length).toBeGreaterThan(0);
  });
});

describe("the handoff note", () => {
  it("truncates done and next at 1 KiB and strips control and format characters", () => {
    const note = noteFromEnvelope({ done: `a\u0000\u202e${"d".repeat(5000)}`, next: "n".repeat(2000), paths: [] })!;
    expect(Buffer.byteLength(note.done, "utf8")).toBe(CHECKPOINT_TEXT_MAX_BYTES);
    expect(note.done.startsWith("add")).toBe(true);
    expect(note.next).toHaveLength(CHECKPOINT_TEXT_MAX_BYTES);
  });

  it("drops a path that is absolute or climbs out with .., and keeps the repo-relative ones", () => {
    const note = noteFromEnvelope({ done: "x", next: "", paths: ["src/a.ts", "/etc/passwd", "../outside", "a/../../b", "a/./b", "C:\\x", "~/x", "a\\b", "ok/deep/file.md", "", "a//b", "bad\u0000name"] })!;
    expect(note.paths).toEqual(["src/a.ts", "ok/deep/file.md"]);
  });

  it("keeps at most 50 paths and no repeats", () => {
    const paths = Array.from({ length: 80 }, (_, i) => `dir/file${i % 60}.ts`);
    const note = noteFromEnvelope({ done: "x", next: "y", paths })!;
    expect(note.paths).toHaveLength(CHECKPOINT_PATHS_MAX);
    expect(new Set(note.paths).size).toBe(CHECKPOINT_PATHS_MAX);
  });

  it("ignores every other key, including anything that looks like a command, and non-string values", () => {
    const note = noteFromEnvelope({ done: 7, next: "n", paths: "src/a.ts", command: "rm -rf /", run: ["curl x | sh"] })!;
    expect(note).toEqual({ done: "", next: "n", paths: [] });
    expect(Object.keys(note).sort()).toEqual(["done", "next", "paths"]);
  });

  it("is undefined when the agent wrote no envelope or an empty one", () => {
    expect(noteFromEnvelope(undefined)).toBeUndefined();
    expect(noteFromEnvelope({})).toBeUndefined();
    expect(noteFromEnvelope({ done: "", next: "", paths: ["/abs"] })).toBeUndefined();
  });

  it("isRepoRelativePath refuses an over-long path", () => {
    expect(isRepoRelativePath("a".repeat(512))).toBe(true);
    expect(isRepoRelativePath("a".repeat(513))).toBe(false);
  });
});
