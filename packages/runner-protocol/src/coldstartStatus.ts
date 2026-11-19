/**
 * D#845 ON-1: the vocabulary of the engine's coldstart status stream (`step=<step> state=<state> [code=<code>]`), copied from the engine's `scripts/coldstart-status-schema.json`.
 * The engine defines it and prints the file's sha256 (`coldstart.sh --print-status-schema`). The file sits here byte for byte (`schema/coldstart-status.v1.json`), this module's lists are
 * read against it by a test, and the hash is pinned below: an engine change to the vocabulary changes the hash, and the test fails until the file, these lists and the pin are updated together.
 * Every name is a closed enum; a name outside it is refused, never passed on.
 */
import { z } from "zod";

/** sha256 of `schema/coldstart-status.v1.json`, as the engine prints it. */
export const COLDSTART_STATUS_SCHEMA_SHA256 = "5d80fd0932de256dc131ea6526f243a4a5d169618070233420be81607f01482a" as const;
export const COLDSTART_STEPS = ["preflight", "interview", "wiring", "deps", "labels", "sandbox_hook", "bundle", "done"] as const;
export const COLDSTART_STATES = ["started", "ok", "failed", "skipped"] as const;
export const COLDSTART_CODES = ["missing_topic", "cloud_owned", "preflight_failed", "wiring_failed", "deps_failed", "interrupted"] as const;
/** `missing_topic` is the one code that carries a suffix: `missing_topic:<id>`. */
export const COLDSTART_CODE_SUFFIX_PATTERN = /^[a-z_]+$/;

export const ColdstartStep = z.enum(COLDSTART_STEPS);
export const ColdstartState = z.enum(COLDSTART_STATES);
export type ColdstartState = z.infer<typeof ColdstartState>;
/** A code as it appears on a status line: one of the closed set, and `missing_topic` with its `:<id>` suffix (and no other code with one). */
export const ColdstartCode = z.string().refine((value) => {
  const [name, suffix, ...rest] = value.split(":");
  if (rest.length > 0 || name === undefined) return false;
  if (name === "missing_topic") return suffix !== undefined && COLDSTART_CODE_SUFFIX_PATTERN.test(suffix);
  return suffix === undefined && (COLDSTART_CODES as readonly string[]).includes(name);
}, { message: "not a coldstart status code" });
export type ColdstartCode = z.infer<typeof ColdstartCode>;
