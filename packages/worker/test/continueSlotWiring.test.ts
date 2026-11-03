import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D#483 S5-j2f: a Continue puts the item back In progress, which holds a build slot, so the performer must claim one (`takeBuildSlot`). The performer's own tests hand it a claim, and
 * nothing exercised the composition root's hand-over: dropping it there left every test green and made Continue skip the slot clamp. This reads the one call that builds the performer
 * and requires it to hand over the root's claim, bound to the runner pool.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "compositionRoot.ts");

describe("the composition root hands the build-slot claim to the Continue performer", () => {
  const text = readFileSync(SRC, "utf8");
  const call = text.split("\n").find((line) => line.includes("createContinueModule("));

  it("the performer is built in exactly one place", () => {
    expect(text.split("createContinueModule(")).toHaveLength(2);
    expect(call).toBeDefined();
  });

  it("that call passes takeBuildSlot, bound to the runner pool and read from advance.takeBuildSlot", () => {
    expect(call).toMatch(/takeBuildSlot:\s*options\.advance\?\.takeBuildSlot\s*\?/);
    expect(call).toMatch(/options\.advance!\.takeBuildSlot!\(pools\.runnerPool,\s*accountId,\s*workItemId,\s*move\)/);
  });
});
