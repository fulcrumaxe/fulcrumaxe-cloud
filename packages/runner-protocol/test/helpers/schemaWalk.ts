import { z } from "zod";

/** G1: a field name that looks like a credential channel. `auth_present` alone is exempt. */
export const CREDENTIAL_NAME = /token|secret|credential|password|cookie|api_?key|auth(?!_present)/i;
/** The only names allowed to match. Each names a public key, a key id, a boolean or a mode, never a secret. */
export const G1_ALLOWLIST = ["public_key_jwk", "keyid", "model_auth_present", "credential_mode"] as const;

/** Every field name in a schema, at any depth, as a dotted path. */
export function fieldPaths(schema: z.ZodTypeAny, prefix = ""): string[] {
  if (schema instanceof z.ZodObject) {
    return Object.entries(schema.shape).flatMap(([key, child]) => [`${prefix}${key}`, ...fieldPaths(child as z.ZodTypeAny, `${prefix}${key}.`)]);
  }
  if (schema instanceof z.ZodArray) return fieldPaths(schema.element, prefix);
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return fieldPaths(schema.unwrap(), prefix);
  if (schema instanceof z.ZodEffects) return fieldPaths(schema.innerType(), prefix);
  if (schema instanceof z.ZodRecord) return fieldPaths(schema.valueSchema, prefix);
  return [];
}

/** The field paths whose last segment matches the credential pattern and is not allowlisted. */
export function g1Violations(schema: z.ZodTypeAny): string[] {
  return fieldPaths(schema).filter((path) => {
    const name = path.slice(path.lastIndexOf(".") + 1);
    return CREDENTIAL_NAME.test(name) && !(G1_ALLOWLIST as readonly string[]).includes(name);
  });
}

/** Every object schema reachable from `schema` is strict. Returns the paths of those that are not. */
export function nonStrictObjects(schema: z.ZodTypeAny, path = "$"): string[] {
  if (schema instanceof z.ZodObject) {
    const here = schema._def.unknownKeys === "strict" ? [] : [path];
    return [...here, ...Object.entries(schema.shape).flatMap(([key, child]) => nonStrictObjects(child as z.ZodTypeAny, `${path}.${key}`))];
  }
  if (schema instanceof z.ZodArray) return nonStrictObjects(schema.element, `${path}[]`);
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return nonStrictObjects(schema.unwrap(), path);
  if (schema instanceof z.ZodEffects) return nonStrictObjects(schema.innerType(), path);
  if (schema instanceof z.ZodRecord) return nonStrictObjects(schema.valueSchema, `${path}{}`);
  return [];
}
