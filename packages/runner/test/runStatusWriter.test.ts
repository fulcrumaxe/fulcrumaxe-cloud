import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { runEventsSeqLockKey as discussionsLockKey } from "../../discussions/src/comments.js";
import { AGENT_OUTPUT_LIMITS, boundAgentOutput } from "../src/agentOutput.js";
import {
  MAX_CHECKPOINT_SUMMARY_BYTES,
  RUN_EVENTS_SEQ_LOCK_SQL,
  runEventsSeqLockKey,
  sanitizeCheckpointSummary,
  writeRunStatus,
  type WriteRunStatusParams,
} from "../src/runStatusWriter.js";

/** D#2 H14c-5c-1 (C48 W-3): the agent-checkpoint branch of the status writer, without a database. */
describe("agent checkpoint refusals (before any query)", () => {
  const agent = { reason: "agent_checkpoint" as const, summary: "s", ccSessionId: "cc-1", meteredUsd: 1, extensionsUsed: 0 };
  const pool = { connect: () => Promise.reject(new Error("a query was attempted")) } as unknown as Pool;
  const params = (o: Partial<WriteRunStatusParams>) => ({ accountId: randomUUID(), runId: randomUUID(), from: "running", to: "timed_out", checkpoint: agent, ...o }) as WriteRunStatusParams;

  it.each<[string, Partial<WriteRunStatusParams>]>([
    ["on killed_spend", { to: "killed_spend" }],
    ["on failed", { to: "failed" }],
    ["from pending", { from: "pending" }],
  ])("is refused %s", async (_l, o) => {
    await expect(writeRunStatus(pool, params(o))).rejects.toThrow(/checkpoint needs/);
  });

  it("is accepted on running -> timed_out (it reaches the database)", async () => {
    await expect(writeRunStatus(pool, params({}))).rejects.toThrow(/a query was attempted/);
  });
});

describe("sanitizeCheckpointSummary", () => {
  it("strips control characters and keeps ordinary text", () => {
    expect(sanitizeCheckpointSummary("a\u0000b\u001b[31mc\r\nd\u007fe\u0085f ok é")).toBe("ab[31mcdef ok é");
    expect(sanitizeCheckpointSummary("a\u202Eb\u200Bc\uFEFFd\u2066e")).toBe("abcde");
  });

  it("caps at 4 KiB of UTF-8 without splitting a character", () => {
    const cut = sanitizeCheckpointSummary("é".repeat(3000)); // 2 bytes each
    expect(Buffer.byteLength(cut)).toBe(MAX_CHECKPOINT_SUMMARY_BYTES);
    expect(cut).toBe("é".repeat(2048));
    const odd = sanitizeCheckpointSummary(`x${"é".repeat(3000)}`); // the 4096th byte would split a character
    expect(Buffer.byteLength(odd)).toBe(MAX_CHECKPOINT_SUMMARY_BYTES - 1);
    expect(odd).not.toContain("�");
    expect(Buffer.byteLength(sanitizeCheckpointSummary("a".repeat(5000)))).toBe(MAX_CHECKPOINT_SUMMARY_BYTES);
  });
});

describe("boundAgentOutput (H14c-3-2c)", () => {
  const wire = (payload: Record<string, unknown>) => Buffer.byteLength(JSON.stringify({ seq: 1_000_000, kind: "agent.output", at: new Date().toISOString(), payload }));

  it("cuts an over-cap message on a code-point boundary and records the whole message's byte length", () => {
    const { payload } = boundAgentOutput("😀".repeat(10_000) + "é");
    expect(payload).toMatchObject({ text: "😀".repeat(8192), truncated: true, original_bytes: 40_002 });
    expect(boundAgentOutput("hi")).toEqual({ payload: { text: "hi" }, storedBytes: 2 });
    expect((boundAgentOutput("€".repeat(20_000)).payload.text as string).length).toBe(10_922); // 32768 / 3 bytes, never a split character
  });

  it.each([
    ["control characters", "\u0001".repeat(32 * 1024)],
    ["quotes", '"'.repeat(32 * 1024)],
    ["backslashes", "\\".repeat(32 * 1024)],
    ["a mix", "\u0001\"\\\n\u007f é 😀".repeat(5000)],
  ])("worst-case escaping (%s) stays under the 64 KiB wire cap", (_l, text) => {
    const { payload } = boundAgentOutput(text);
    expect(wire(payload)).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(AGENT_OUTPUT_LIMITS.maxPayloadJsonBytes);
  });

  it("replaces a NUL and a lone surrogate, which jsonb cannot store", () => {
    expect(boundAgentOutput("a\u0000b\ud800c").payload).toEqual({ text: "a\uFFFDb\uFFFDc" });
  });
});

describe("run_events writers (H14c-3-2c criteria 1 and 4)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packages = path.join(here, "..", "..");
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((e) => {
      if (e === "node_modules") return [];
      const full = path.join(dir, e);
      return statSync(full).isDirectory() ? sources(full) : /\.(ts|tsx|js|mjs)$/.test(e) ? [full] : [];
    });
  }

  it("exactly two files insert into run_events: runStatusWriter.ts and comments.ts", () => {
    const files = readdirSync(packages).flatMap((pkg) => {
      try {
        return sources(path.join(packages, pkg, "src"));
      } catch {
        return [];
      }
    });
    const inserters = files.filter((f) => /\bINSERT\s+INTO\s+(?:"?public"?\.)?"?run_events\b/i.test(strip(readFileSync(f, "utf8"))));
    expect(inserters.map((f) => path.relative(packages, f)).sort()).toEqual(["discussions/src/comments.ts", "runner/src/runStatusWriter.ts"]);
  });

  it("both inserters take the same per-run lock, with the same key for the same run", () => {
    const runId = randomUUID();
    expect(runEventsSeqLockKey(runId)).toBe(discussionsLockKey(runId));
    expect(runEventsSeqLockKey(runId)).not.toBe(runEventsSeqLockKey(randomUUID()));
    const comments = readFileSync(path.join(packages, "discussions", "src", "comments.ts"), "utf8");
    expect(comments).toContain(RUN_EVENTS_SEQ_LOCK_SQL);
    expect(readFileSync(path.join(packages, "runner", "src", "runStatusWriter.ts"), "utf8")).toContain("RUN_EVENTS_SEQ_LOCK_SQL, [runEventsSeqLockKey(runId)]");
    expect(comments).toContain("[runEventsSeqLockKey(runId)]");
  });
});
