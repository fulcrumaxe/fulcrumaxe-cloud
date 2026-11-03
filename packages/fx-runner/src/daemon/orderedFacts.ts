/**
 * D#483 S5-j2c2: the runner's ordering fact for a merge order, computed from the objects it fetched itself (the public head, the code repository's default tip and their merge base).
 *
 * The cloud sends the repository's ordered-resource configuration (`ordered_config`); the runner compiles it again with the protocol's own module, so it checks the same rules as the
 * cloud's reads do. What leaves the machine is a closed verdict, `part()` codes for the first offending resource and key, the tip's sha and two booleans: no path of its own, no
 * content, no diff. A path git and GitHub might read differently (not valid UTF-8), a tree that cannot be read whole and a missing merge base are `unknown`, never a guess.
 */
import { checkOrdering, detectResource, orderedCode, readOrderedConfig, type PlaneMergeOrderedConfig, type PlaneMergeOrderedFact, type ResourceRule } from "@fulcrumaxe/runner-protocol";
import { diffTreeEntries, type TreeMap } from "@fulcrumaxe/runner-protocol/planePush";

type Verdict = Pick<PlaneMergeOrderedFact, "verdict" | "resource" | "key" | "highest">;

/**
 * The resources that apply, from the cloud's wire configuration, compiled again here. `null` when the runner cannot reproduce the cloud's list (an entry it refuses): nothing is
 * then read as in order. `configured` with no resource, or no detected default, is "none apply".
 */
export function resolveResources(config: PlaneMergeOrderedConfig, tipPaths: readonly string[]): ResourceRule[] | null {
  const compiled = readOrderedConfig({
    orderedResources: config.resources.map((r) => ({ name: r.name, pathPattern: r.path_pattern, keyPattern: r.key_pattern, keyKind: r.key_kind })),
  });
  if (config.configured) return compiled.resources.length === config.resources.length ? compiled.resources : null;
  const detected = detectResource(tipPaths);
  return detected === null ? [] : [detected];
}

/** The verdict, a pure function of the resources, the tip's paths and the paths the pull request adds. The first resource out of order names itself. */
export function decideOrdered(resources: readonly ResourceRule[], tipPaths: readonly string[], added: readonly string[]): Verdict {
  // `none` is "this pull request adds no ordered file": the cloud frees the order lease on it, and holds the repository on `ok`.
  if (resources.length === 0 || !added.some((p) => resources.some((r) => r.matches(p)))) return { verdict: "none" };
  for (const rule of resources) {
    const v = checkOrdering(rule, added, tipPaths);
    if (!v.ok) return { verdict: "out_of_order", resource: orderedCode("resource", rule.name), key: orderedCode("key", v.key), highest: orderedCode("highest", v.highest) };
  }
  return { verdict: "ok" };
}

/** Whether the files the tip gained since the merge base and the files the pull request changed share a path. */
export function pathsOverlap(gained: readonly string[], mine: readonly string[]): boolean {
  const own = new Set(mine);
  return gained.some((p) => own.has(p));
}

export interface OrderedFactsInput {
  config: PlaneMergeOrderedConfig;
  /** The default tip the facts are computed at, and the merge base of the public head with it. */
  tip: string;
  mergeBase: string;
  /** The trees of the merge base, the public head and the tip, read strictly (a tree that could not be read is not passed). */
  baseTree: TreeMap;
  headTree: TreeMap;
  tipTree: TreeMap;
}

/** The unknown fact at `tip`: a verdict that blocks on its own, so its two booleans carry nothing. */
export const unknownFact = (tip: string): PlaneMergeOrderedFact => ({ verdict: "unknown", tip_sha: tip, behind: false, overlap: false });

/** The fact for the public head against the tip, from trees alone. Pure: no read, no throw. */
export function orderedFactOf(input: OrderedFactsInput): PlaneMergeOrderedFact {
  const tipPaths = [...input.tipTree.keys()];
  const resources = resolveResources(input.config, tipPaths);
  if (resources === null) return unknownFact(input.tip);
  const behind = input.mergeBase !== input.tip;
  const mine = diffTreeEntries(input.baseTree, input.headTree, () => true).paths;
  const added = mine.filter((p) => !input.baseTree.has(p));
  const overlap = behind && pathsOverlap(diffTreeEntries(input.baseTree, input.tipTree, () => true).paths, mine);
  return { ...decideOrdered(resources, tipPaths, added), tip_sha: input.tip, behind, overlap };
}
