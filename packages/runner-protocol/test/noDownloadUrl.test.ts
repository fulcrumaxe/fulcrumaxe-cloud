import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RegisterResponse } from "../src/messages.js";
import { RUNNER_REPLIES } from "../src/replies.js";

/**
 * D#6 R6-2a (correction C38 section 2): the cloud never tells a runner where to download an update. The runner learns about releases
 * only from signed release metadata at locations compiled into the build, so no reply the cloud can send carries a download address.
 */

/** Every field name reachable in a schema, at any depth, through objects, arrays, unions, wrappers and records. */
function names(schema: z.ZodTypeAny, prefix = ""): string[] {
  if (schema instanceof z.ZodObject) {
    return Object.entries(schema.shape).flatMap(([key, child]) => [`${prefix}${key}`, ...names(child as z.ZodTypeAny, `${prefix}${key}.`)]);
  }
  if (schema instanceof z.ZodUnion) return (schema.options as z.ZodTypeAny[]).flatMap((option) => names(option, prefix));
  if (schema instanceof z.ZodDiscriminatedUnion) return [...(schema.options as z.ZodTypeAny[])].flatMap((option) => names(option, prefix));
  if (schema instanceof z.ZodArray) return names(schema.element, prefix);
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return names(schema.unwrap(), prefix);
  if (schema instanceof z.ZodEffects) return names(schema.innerType(), prefix);
  if (schema instanceof z.ZodRecord) return names(schema.valueSchema, prefix);
  if (schema instanceof z.ZodDefault) return names(schema._def.innerType as z.ZodTypeAny, prefix);
  return [];
}

/** A field that could carry an address to fetch a program, an update or a release from. */
const DOWNLOAD_FIELD = /url|uri|href|link|download|update|upgrade|release|binary|artifact|asset|installer/i;

const violations = (schema: z.ZodTypeAny): string[] => names(schema).filter((path) => DOWNLOAD_FIELD.test(path.slice(path.lastIndexOf(".") + 1)));

describe("no cloud response schema has a download-URL field", () => {
  it("holds for every runner reply and the registration response", () => {
    const all: Array<[string, z.ZodTypeAny]> = [...Object.entries(RUNNER_REPLIES), ["register_response", RegisterResponse]];
    expect(all.length).toBeGreaterThan(8);
    for (const [name, schema] of all) expect(violations(schema), name).toEqual([]);
  });

  it("the walk does reach fields inside a union and a signed job, and the pattern does catch a download field", () => {
    expect(names(RUNNER_REPLIES.claim)).toEqual(expect.arrayContaining(["signed_job", "signed_job.job.run_id", "retry_after"]));
    expect(names(RUNNER_REPLIES.git_ticket)).toEqual(expect.arrayContaining(["ticket", "proxy_origin"]));
    const bad = z.union([z.object({ ok: z.literal(true) }), z.object({ nested: z.array(z.object({ update_url: z.string() })) })]);
    expect(violations(bad)).toEqual(["nested.update_url"]);
    for (const word of ["download_url", "binary_href", "release_link", "installer", "artifactUri"]) expect(DOWNLOAD_FIELD.test(word), word).toBe(true);
  });
});
