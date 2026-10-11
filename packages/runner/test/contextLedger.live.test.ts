import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ContextLedgerCapture } from "@fulcrumaxe/runner-protocol";

/**
 * D#600 CX-1a, real contract: the capture against the stream of the REAL installed CLI. One short model turn on the operator's own
 * login, so it is skipped unless `FX_CONTEXT_LEDGER_LIVE=1` and `FX_CLAUDE_BIN` names the CLI (an absolute path). It records nothing and
 * writes no file. The unit tests use the recorded, redacted stream (packages/runner-protocol/test/fixtures/context-ledger.recorded.jsonl);
 * this is the check that the CLI still emits the usage keys the capture reads.
 */
const ON = process.env.FX_CONTEXT_LEDGER_LIVE === "1" && (process.env.FX_CLAUDE_BIN ?? "") !== "";

describe.skipIf(!ON)("context ledger capture against the real CLI", () => {
  it("a one-turn print-mode run is measured, and the figures equal an independent sum of the usage keys", () => {
    const out = spawnSync(process.env.FX_CLAUDE_BIN!, ["-p", "--output-format", "stream-json", "--verbose", "--max-turns", "1", "--tools", "", "Reply with the single word ok."], {
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(out.status).toBe(0);
    const lines = out.stdout.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
    const byId = new Map<string, number>();
    for (const l of lines) {
      const m = l.type === "assistant" ? (l.message as { id?: string; usage?: Record<string, number> }) : undefined;
      if (m?.id !== undefined && m.usage !== undefined) byId.set(m.id, (m.usage.input_tokens ?? 0) + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0));
    }
    expect(byId.size).toBeGreaterThan(0);
    const capture = new ContextLedgerCapture();
    for (const l of lines) capture.observe(l);
    const m = capture.snapshot();
    expect(m.basis).toBe("measured");
    expect(m.peak_context_tokens).toBe(Math.max(...byId.values()));
    expect(m.first_turn_input_tokens).toBe([...byId.values()][0]);
    expect(m.compactions).toBe(0);
  });
});
