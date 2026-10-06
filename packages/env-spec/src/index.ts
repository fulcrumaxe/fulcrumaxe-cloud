export { EnvSpecError, fieldName, type ErrorCode, type Path } from "./errors.js";
export { parse, type ParseResult } from "./parse.js";
export {
  BASE_DIGEST, EMPTY_INPUTS_DIGEST, KNOWN_PRESET_IDS, MAX_PRESETS, NIX_DEFAULTS, TOP_LEVEL_KEYS,
  canonicalize, envVersionId, inputsDigest, isInputFile, normalize,
  type Argv, type EnvSecret, type EnvSpec, type NixSpec, type NixSubstituter, type SecretKind, type TreeEntry,
} from "./spec.js";
export { LIMITS, looksLikeImageRef, validate } from "./validate.js";
