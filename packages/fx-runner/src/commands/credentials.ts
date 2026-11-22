/**
 * `fx-runner credentials set-api-key | clear-api-key | status` (D#6 R5b-3). The key is read from standard input only and never taken as an argument; it is
 * stored by `src/credentials.ts`. Nothing printed here holds the key: `status` says only "stored" or "not stored".
 */
import { CliError } from "../cliError.js";
import { loadRegistration } from "../config.js";
import type { CommandContext } from "../context.js";
import { ApiKeyError, clearApiKey, readApiKey, writeApiKey } from "../credentials.js";

import { VM_TOKEN_USAGE, clearVmToken, vmTokenStatus, writeVmToken } from "../credentials/vmToken.js";

export const CREDENTIALS_USAGE = "credentials takes one of set-api-key, clear-api-key, status, set-vm-token, clear-vm-token or vm-token-status, and never a key or token as an argument (it is read from standard input)";

export async function credentialsCommand(words: readonly string[], ctx: CommandContext, readSecret: (() => Promise<string>) | undefined, readVmSecret?: () => Promise<string>): Promise<number> {
  // A word after set-vm-token could be a token typed in the wrong place: refuse with fixed text that repeats nothing, and store nothing.
  if (words[0] === "set-vm-token" && words.length > 1) throw new CliError(VM_TOKEN_USAGE, 2);
  const sub = words.length === 1 ? words[0] : undefined;
  if (sub === "set-vm-token") {
    if (readVmSecret === undefined) throw new CliError("set-vm-token is only available from the fx-runner program");
    writeVmToken(ctx.stateDir, ctx.uid, await readVmSecret());
    ctx.out("VM token stored. It applies from the next job. It is not revoked by removing it: revoke it in your Claude account if it may have been exposed.");
    return 0;
  }
  if (sub === "clear-vm-token") {
    ctx.out(clearVmToken(ctx.stateDir, ctx.uid) ? "VM token removed. Revoke it in your Claude account if it may have been exposed." : "No VM token was stored.");
    return 0;
  }
  if (sub === "vm-token-status") {
    const status = vmTokenStatus(ctx.stateDir, ctx.uid);
    ctx.out(status.state === "present" ? `present (${status.source}, set ${status.ageDays} days ago)` : status.state);
    return 0;
  }
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
