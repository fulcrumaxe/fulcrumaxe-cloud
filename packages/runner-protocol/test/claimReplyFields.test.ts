import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ClaimReply } from "../src/replies.js";
import { COVERED } from "./helpers/claimReplyCovered.js";

/**
 * D#6 RUNNER-REPLY-CAP: `MAX_CLAIM_REPLY_BYTES` (claimReplyBound.ts) is worked out from the caps of the job's long fields, plus a fixed envelope for everything small.
 * A field added to the job or the claim reply that is not small would leave the bound too low, and the runner would cut a job the cloud was allowed to sign. Nothing else
 * ties a new field to the bound, so this test pins every field path reachable in a claim reply, each with the way the bound covers it.
 */

/** Every field path reachable in a schema, at any depth, through objects, arrays, unions, wrappers and records. */
function paths(schema: z.ZodTypeAny, prefix = ""): string[] {
  if (schema instanceof z.ZodObject) {
    return Object.entries(schema.shape).flatMap(([key, child]) => [`${prefix}${key}`, ...paths(child as z.ZodTypeAny, `${prefix}${key}.`)]);
  }
  if (schema instanceof z.ZodUnion) return (schema.options as z.ZodTypeAny[]).flatMap((option) => paths(option, prefix));
  if (schema instanceof z.ZodDiscriminatedUnion) return [...(schema.options as z.ZodTypeAny[])].flatMap((option) => paths(option, prefix));
  if (schema instanceof z.ZodArray) return paths(schema.element, prefix);
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return paths(schema.unwrap(), prefix);
  if (schema instanceof z.ZodEffects) return paths(schema.innerType(), prefix);
  if (schema instanceof z.ZodRecord) return paths(schema.valueSchema, prefix);
  if (schema instanceof z.ZodDefault) return paths(schema._def.innerType as z.ZodTypeAny, prefix);
  return [];
}

describe("every field a claim reply can carry is accounted for in the reply bound", () => {
  it("lists exactly the fields claimReplyBound.ts covers", () => {
    const reachable = [...new Set(paths(ClaimReply))].sort();
    const covered = Object.keys(COVERED).sort();
    const added = reachable.filter((path) => !covered.includes(path));
    const gone = covered.filter((path) => !reachable.includes(path));
    const message =
      `a claim reply gained fields [${added.join(", ")}] and lost fields [${gone.join(", ")}]. A new job field needs a term in MAX_CLAIM_REPLY_BYTES ` +
      `(packages/runner-protocol/src/claimReplyBound.ts) if it can be long, and a place in largestSignedJob (packages/fx-runner/test/helpers/largestJob.ts); ` +
      `then list it in COVERED above. A removed field needs its entry taken out here.`;
    expect({ added, gone }, message).toEqual({ added: [], gone: [] });
  });
});
