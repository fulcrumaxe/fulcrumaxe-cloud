import { CATALOGUE_VERSION, resolveEngineDecision } from "@fx/decisions";
import { pgEngineDialsPorts, type DialResolver, type EngineDialsPorts } from "./engineDials.js";

/**
 * The one place the dials route meets the decisions catalogue (the engine decision resolution from EB-9a). A repo's stored dial is resolved the way the decide
 * route resolves it. For `engine_spec_ready` the tag is taken as `small`: the snapshot reports the repo's own dial, which is what a Small, Bug, Doc or Process
 * Spec follows. A Feature or Critical Spec asks at every preset and is not something a ceiling can express.
 */
export const catalogueResolver: DialResolver = {
  catalogueVersion: CATALOGUE_VERSION,
  resolve: (decisionType, stored) => resolveEngineDecision({ decisionType, tag: decisionType === "engine_spec_ready" ? "small" : undefined, stored }).disposition,
};

export const defaultEngineDialsPorts = (): EngineDialsPorts => pgEngineDialsPorts(catalogueResolver);
