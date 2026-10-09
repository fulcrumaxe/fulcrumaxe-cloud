import { describe, expect, it } from "vitest";
import { CLI_MODEL_NAMES, type PriceModelId } from "@fulcrumaxe/runner-protocol";
import { claudeModelIds, type ModelId } from "@fx/spend";

/** `true` only when A and B are the same type, not merely assignable one way. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Compile-time: the runner protocol's price-table ids and @fx/spend's model ids are one set. A model added to either side alone
// makes this line a type error, which is the exhaustiveness the old `Record<ModelId, string>` gave the CLI-name table.
const sameIds: Same<PriceModelId, ModelId> = true;

describe("the CLI-name table covers the price table", () => {
  it("PriceModelId and ModelId are the same type (checked by tsc)", () => {
    expect(sameIds).toBe(true);
  });

  it("the table has exactly the model ids the price table has", () => {
    expect(Object.keys(CLI_MODEL_NAMES).sort()).toEqual([...claudeModelIds()].sort());
  });
});
