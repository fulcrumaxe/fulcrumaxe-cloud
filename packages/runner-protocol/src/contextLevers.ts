/**
 * D#600 CX-6a: the fixed numbers behind the two CLI levers that keep a run's context small, and the one function that turns a turn's token
 * count into a percentage of the model's window. The cloud's sandbox and the local runner both read these, so they cannot drift apart.
 *
 *  - `BASH_MAX_OUTPUT_LENGTH`: the size, in characters, above which the CLI does not hand a Bash answer to the model whole. CLI 2.1.302 then writes the output to a file under its config directory and returns a block with a preview of about 2 KB (it does not cut).
 *  - `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`: the percentage of the window at which the CLI compacts on its own.
 *
 * Both are constants, not settings: nothing a person, a repo or a job can change reaches them.
 */
export const BASH_MAX_OUTPUT_LENGTH = 30000;
export const CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = 85;

/** The two env variables, as the CLI reads them (string values). Spread into a sandbox env or a job env. */
export const CONTEXT_LEVER_ENV: Readonly<Record<string, string>> = Object.freeze({
  BASH_MAX_OUTPUT_LENGTH: String(BASH_MAX_OUTPUT_LENGTH),
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(CLAUDE_AUTOCOMPACT_PCT_OVERRIDE),
});

/** The percentage of the window at which the run starts to say so (the limits file carries `context_pct` from here on). */
export const CONTEXT_WARN_PCT = 70;

/**
 * The whole percentage of `windowTokens` that `contextTokens` fills, rounded down, never above 100. `undefined` when either figure is not a
 * positive safe integer (the caller then says nothing rather than guess).
 */
export function contextPct(contextTokens: number, windowTokens: number): number | undefined {
  if (!Number.isSafeInteger(contextTokens) || contextTokens < 0 || !Number.isSafeInteger(windowTokens) || windowTokens <= 0) return undefined;
  return Math.min(Math.floor((contextTokens * 100) / windowTokens), 100);
}

/**
 * D#600 CX-6b: the context warning's code and its one line, shared by the cloud's sandbox hook and the local runner's note so the two cannot drift. The code differs from the
 * time and call warnings' codes and so does the text. `{N}` is one whole number; the text holds no quote, backslash, dollar sign or backtick (the hook prints it from a shell script).
 */
export const CONTEXT_WARNING_CODE = "context_warning";
export const CONTEXT_WARNING_TEXT = "Context is at {N}% of the window: finish, or end with a checkpoint envelope";

/** The line the local runner puts ahead of the prompt of a turn it starts: the hook's text, closed by the same full stop. `pct` is a whole number from `CONTEXT_WARN_PCT` to 100. */
export function contextNoteLine(pct: number): string {
  return `${CONTEXT_WARNING_TEXT.replace("{N}", String(pct))}.`;
}

/** The largest window a job may name, in tokens (the price table's own bound). */
export const CONTEXT_WINDOW_MAX_TOKENS = 10_000_000;
