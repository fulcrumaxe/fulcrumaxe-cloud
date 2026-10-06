/**
 * The three presets, as data (owner decision 5, DP-OD1; disposition
 * vocabulary per DP-C1, the Team Lead's clarification on D#7).
 *
 * A preset is a named point in the class x disposition matrix, not a code
 * path. It moves exactly one thing: the `human_over_the_loop` (class 2)
 * tier. Class 1 is always `"act"` and class 3 is always `"ask"`, on every
 * preset -- `test/presets.test.ts` asserts this exhaustively, along with
 * every pair of presets differing on class 2 (DP-C1's fix for the earlier
 * binary `auto | ask` vocabulary, under which Balanced and Autonomous
 * were identical).
 *
 * The names are the owner's three, kept as-is (DP-OD1): renaming them
 * after the paper the naming *principle* is borrowed from
 * (arXiv:2506.12469) is rejected as churn. Each carries the one line
 * naming the customer's role in it, verbatim from DP-OD1.
 */
import type { Preset, PresetName } from "./types.js";

export const CAUTIOUS_PRESET: Preset = {
  name: "cautious",
  label: "Cautious",
  customerRoleDescription: "you approve",
  dispositions: {
    automated_with_monitoring: "act",
    human_over_the_loop: "ask",
    human_in_the_loop: "ask",
  },
};

export const BALANCED_PRESET: Preset = {
  name: "balanced",
  label: "Balanced",
  customerRoleDescription: "you oversee, and can reverse",
  dispositions: {
    automated_with_monitoring: "act",
    human_over_the_loop: "announce",
    human_in_the_loop: "ask",
  },
};

export const AUTONOMOUS_PRESET: Preset = {
  name: "autonomous",
  label: "Autonomous",
  customerRoleDescription: "you observe",
  dispositions: {
    automated_with_monitoring: "act",
    human_over_the_loop: "act",
    human_in_the_loop: "ask",
  },
};

export const PRESETS: readonly Preset[] = [CAUTIOUS_PRESET, BALANCED_PRESET, AUTONOMOUS_PRESET];

export class UnknownPresetError extends Error {
  constructor(name: string) {
    super(`unknown preset: "${name}"`);
    this.name = "UnknownPresetError";
  }
}

/** Looks up a preset by name. Throws `UnknownPresetError` for anything else. */
export function getPreset(name: PresetName): Preset {
  const preset = PRESETS.find((p) => p.name === name);
  if (!preset) throw new UnknownPresetError(name);
  return preset;
}
