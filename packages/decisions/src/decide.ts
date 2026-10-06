/**
 * `decide()` -- the pure resolver (D#7 DP1), shaped like
 * `packages/gh-policy/src/decide.ts`.
 *
 * Pure and total: same inputs always yield the same output, no I/O of any
 * kind, no `Date.now()` or other hidden clock read. The orchestrator calls
 * this after reading a role's `decision_request` from the AGENT_OUTPUT
 * envelope (DP4 territory) -- the agent never sees the policy, and it never
 * supplies the class: a `class` field on an inbound request is rejected
 * outright (C2), never honoured.
 */
import type {
  CatalogueEntry,
  DecisionRequest,
  DecisionResult,
  DecisionSettings,
  Disposition,
} from "./types.js";
import { getPreset } from "./presets.js";

/**
 * Thrown when an inbound decision-request object carries a `class` field.
 * The class comes from the catalogue entry a tool or role card statically
 * declares (DP5), never from the agent that just made the decision (C2) --
 * see the Implementation Notes in D#7: "Do not add a class field to
 * anything an agent writes."
 */
export class DecisionRequestClassFieldRejectedError extends Error {
  constructor(type: string) {
    super(
      `decision_request for type "${type}" supplied a "class" field; class comes from the ` +
        `catalogue entry a tool or role card statically declares, and is never accepted from ` +
        `the request itself.`,
    );
    this.name = "DecisionRequestClassFieldRejectedError";
  }
}

/**
 * Rejects a request object that carries an own `class` property, however
 * it got there -- an honest caller's `DecisionRequest` never has one, so
 * this only ever fires on a hostile or malformed input. Checked before
 * anything else in `decide()` so the rejection precedes every other branch.
 */
function assertNoInboundClass(request: DecisionRequest): void {
  if (Object.prototype.hasOwnProperty.call(request, "class")) {
    throw new DecisionRequestClassFieldRejectedError(request.type);
  }
}

/**
 * `Disposition` ordered from most permissive to most conservative (DP-C1:
 * "clamps toward the more conservative value (act -> announce -> ask)").
 * `clampDisposition` walks this array forward from `proposed`'s own
 * position -- never backward -- so a disallowed proposal only ever
 * degrades, it never escalates to something more permissive than what a
 * preset actually asked for.
 */
const DISPOSITIONS_MOST_TO_LEAST_PERMISSIVE: readonly Disposition[] = ["act", "announce", "ask"];

/**
 * Clamps `proposed` to `allowedDispositions`. If `proposed` is itself
 * permitted, it is returned unchanged. Otherwise the more conservative
 * values are tried in turn (`act` -> `announce` -> `ask`) until one is
 * permitted. `defaultDisposition` is the last resort -- reached only for an
 * entry whose `allowedDispositions` excludes every value from `proposed`
 * down through `"ask"`, which the v1 catalogue never does (every entry's
 * `allowedDispositions` includes its own `defaultDisposition`), but
 * `decide()` stays total regardless.
 */
function clampDisposition(
  proposed: Disposition,
  allowedDispositions: readonly Disposition[],
  defaultDisposition: Disposition,
): Disposition {
  const startIndex = DISPOSITIONS_MOST_TO_LEAST_PERMISSIVE.indexOf(proposed);
  for (const candidate of DISPOSITIONS_MOST_TO_LEAST_PERMISSIVE.slice(startIndex)) {
    if (allowedDispositions.includes(candidate)) return candidate;
  }
  return defaultDisposition;
}

/**
 * Resolves one decision request to a class and a disposition.
 *
 * `entry` is the catalogue entry already looked up for `request.type`
 * (see `getCatalogueEntry` in `catalogue.ts`) -- `undefined` when the type
 * is not in the catalogue at all. An unknown type is never guessed: it
 * resolves to class 3, the same class a `human_in_the_loop` entry always
 * asks under (C1, criterion 6).
 *
 * For a known entry, the preset supplies the proposed disposition for the
 * entry's class. Class 1 is always `"act"` and class 3 is always `"ask"`
 * on every preset (owner decision 5) -- only class 2 varies, per DP-C1's
 * `ask | announce | act` vocabulary. The proposed disposition is then
 * clamped to `entry.allowedDispositions` (see `clampDisposition` above).
 *
 * The entry's two DP-OD2 documentation fields (recorded for future
 * routing, not resolution) are never read here (criterion 2):
 * reversibility (`entry.reversal`, itself unused in v1's resolution) and
 * blast radius (`entry.class`) are the only resolution axes.
 */
export function decide(
  entry: CatalogueEntry | undefined,
  settings: DecisionSettings,
  request: DecisionRequest,
): DecisionResult {
  assertNoInboundClass(request);

  if (entry === undefined) {
    return { class: "human_in_the_loop", disposition: "ask" };
  }

  const preset = getPreset(settings.preset);
  const proposed = preset.dispositions[entry.class];
  const disposition = clampDisposition(proposed, entry.allowedDispositions, entry.defaultDisposition);

  return { class: entry.class, disposition };
}
