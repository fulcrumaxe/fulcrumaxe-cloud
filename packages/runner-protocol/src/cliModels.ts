/**
 * The price-table model ids a job carries (`model_hint`) and the names the Claude Code CLI takes for `--model`. A job names a
 * model by its price-table id, so that pricing and follow-up runs see one id everywhere; every place that starts the CLI maps the id
 * through this table first, and refuses an id the table lacks before any process exists. The cloud's sandbox target and the local
 * runner share this one table, so the two cannot drift apart.
 *
 * Confirmed against the installed CLI (2.1.295, 2026-10-09): each value is accepted as `--model`, and `message.model` reports the
 * same name back. The price-table ids themselves are not CLI names: the CLI answers "There's an issue with the selected model".
 */
export type PriceModelId = "haiku-4.5" | "sonnet-5" | "opus-5";

export const CLI_MODEL_NAMES: Readonly<Record<PriceModelId, string>> = {
  "haiku-4.5": "claude-haiku-4-5",
  "sonnet-5": "claude-sonnet-5",
  "opus-5": "claude-opus-5",
};

/** The CLI's `--model` name for a price-table id, else `undefined` (own keys only: `constructor` and `__proto__` are not ids). */
export function cliModelNameFor(id: string): string | undefined {
  return Object.hasOwn(CLI_MODEL_NAMES, id) ? CLI_MODEL_NAMES[id as PriceModelId] : undefined;
}

/** The price-table id whose CLI name is `cliName`, else `undefined`. */
export function modelIdForCliName(cliName: string): PriceModelId | undefined {
  return (Object.keys(CLI_MODEL_NAMES) as PriceModelId[]).find((id) => CLI_MODEL_NAMES[id] === cliName);
}
