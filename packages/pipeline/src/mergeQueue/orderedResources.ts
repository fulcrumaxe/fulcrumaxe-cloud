// D#483 S5-j2c2: the pure half of the ordered-resource check lives in the runner protocol, so the runner computes the same check on the objects it fetched itself. Re-exported here so no importer changes.
export {
  KEY_PATTERN_COST_LIMIT,
  MAX_GLOB,
  MAX_KEY_INPUT,
  MAX_KEY_PATTERN,
  MAX_NAME,
  MAX_RESOURCES,
  checkOrdering,
  compileGlob,
  compileKeyPattern,
  detectResource,
  orderedCode,
  orderedConfigWire,
  parseKey,
  readOrderedConfig,
} from "@fulcrumaxe/runner-protocol";
export type { Key, KeyKind, OrderVerdict, OrderedConfig, ResourceRule } from "@fulcrumaxe/runner-protocol";
