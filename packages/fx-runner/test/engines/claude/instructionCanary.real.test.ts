import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInstructionCanary } from "../../../src/engines/claude/instructionCanary.js";
import { resolveClaudePath } from "../../../src/engines/claude/pin.js";
import { cleanEnv } from "../../../src/job/cleanEnv.js";
import { tmpRoot } from "../../helpers/tmpRoot.js";

/**
 * D#601 MEM-7 acceptance 1, against the REAL installed CLI (instruction-file loading cannot be faked faithfully). Opt-in, because it starts the
 * program and each run is one short model turn on the user's own login: skipped unless `FX_INSTRUCTION_CANARY_REAL_CLI=1`, and always skipped under
 * `FX_FORBID_MODEL_CALLS=1` (the repo's model-call guard). It makes exactly two real calls: one with `--setting-sources ""` (must pass) and one
 * with `project` (must fail as `instruction_file_loaded`).
 *
 *     FX_INSTRUCTION_CANARY_REAL_CLI=1 pnpm exec vitest run test/engines/claude/instructionCanary.real.test.ts      (with FX_FORBID_MODEL_CALLS unset)
 */
const ON = process.env.FX_INSTRUCTION_CANARY_REAL_CLI === "1" && process.env.FX_FORBID_MODEL_CALLS !== "1";

describe.skipIf(!ON)("the real installed CLI and a canary CLAUDE.md", () => {
  it("passes with `--setting-sources \"\"` and fails as instruction_file_loaded with `project`", { timeout: 240_000 }, async () => {
    const env = cleanEnv({ mode: "subscription" });
    const binaryPath = resolveClaudePath(env.PATH ?? "");
    const tempRoot = mkdtempSync(path.join(tmpRoot(), "fxr-canary-real-"));
    try {
      expect(await runInstructionCanary({ binaryPath, env, spawn, tempRoot })).toEqual({ ok: true });
      expect(await runInstructionCanary({ binaryPath, env, spawn, tempRoot, settingSources: "project" })).toEqual({ ok: false, reason: "instruction_file_loaded" });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
