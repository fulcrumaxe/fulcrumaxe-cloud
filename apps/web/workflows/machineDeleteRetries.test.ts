import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DELETE_STEP_RETRIES } from "../lib/machineDeleteRetries";

/**
 * The delete steps write the run as failed on the try after the runtime's last retry, so the number the code assumes must be the number the runtime uses. The runtime keeps its default
 * in a private constant, so this reads it from the installed file; if the file moves or the constant is renamed the test fails rather than passing on nothing.
 */
describe("delete step retries", () => {
  it("equals the Workflow runtime's default step retry count", () => {
    const fromWorkflow = createRequire(createRequire(import.meta.url).resolve("workflow"));
    const runtimeDir = dirname(fromWorkflow.resolve("@workflow/core/runtime"));
    const source = readFileSync(join(runtimeDir, "runtime", "step-handler.js"), "utf8");
    const found = /\bDEFAULT_STEP_MAX_RETRIES\s*=\s*(\d+)\s*;/.exec(source);
    expect(found, "DEFAULT_STEP_MAX_RETRIES not found in the installed @workflow/core").not.toBeNull();
    expect(Number(found![1])).toBe(DELETE_STEP_RETRIES);
  });
});
