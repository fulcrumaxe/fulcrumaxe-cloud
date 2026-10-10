/**
 * `fx-runner credentials set-api-key | clear-api-key | status` (D#6 R5b-3). The key is read from standard input only and never taken as an argument; it is
 * stored by `src/credentials.ts`. Nothing printed here holds the key: `status` says only "stored" or "not stored".
 */
import { CliError } from "../cliError.js";
import { loadRegistration } from "../config.js";
import type { CommandContext } from "../context.js";
import { ApiKeyError, clearApiKey, readApiKey, writeApiKey } from "../credentials.js";

export const CREDENTIALS_USAGE = "credentials takes one of set-api-key, clear-api-key or status, and never a key as an argument (the key is read from standard input)";

export async function credentialsCommand(words: readonly string[], ctx: CommandContext, readSecret: (() => Promise<string>) | undefined): Promise<number> {
  const sub = words.length === 1 ? words[0] : undefined;
  if (sub === "set-api-key") {
    if (readSecret === undefined) throw new CliError("set-api-key is only available from the fx-runner program");
    writeApiKey(ctx.stateDir, ctx.uid, await readSecret());
    ctx.out("API key stored.");
    try {
      if (loadRegistration(ctx.stateDir)?.credential_mode === "subscription") ctx.out("This runner is registered in subscription mode, so the key is not used.");
    } catch {
      // fx-swallow-ok: a damaged registration is for status and doctor to report; the key is stored either way
    }
    return 0;
  }
  if (sub === "clear-api-key") {
    ctx.out(clearApiKey(ctx.stateDir, ctx.uid) ? "API key removed." : "No API key was stored.");
    return 0;
  }
  if (sub === "status") {
    try {
      readApiKey(ctx.stateDir, ctx.uid);
      ctx.out("stored");
    } catch (error) {
      if (!(error instanceof ApiKeyError) || error.code !== "api_key_not_configured") throw error;
      ctx.out("not stored");
    }
    return 0;
  }
  throw new CliError(CREDENTIALS_USAGE, 2);
}
